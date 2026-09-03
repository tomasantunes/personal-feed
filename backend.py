from datetime import datetime, timezone
import base64
import io
import json
import mimetypes
import re
import zipfile
from bson import ObjectId
from bson.errors import InvalidId
from pymongo import ReturnDocument

COLLECTION_NAME = 'personal_feed_posts'
MAX_CONTENT_LENGTH = 5000
MAX_IMAGE_BYTES = 5 * 1024 * 1024
DEFAULT_LIMIT = 8
MAX_LIMIT = 50
ALLOWED_IMAGE_TYPES = {'image/jpeg', 'image/png', 'image/gif', 'image/webp'}


def _now():
    return datetime.now(timezone.utc)


def _serialize_datetime(value):
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return value


def _serialize_post(post, include_image=True):
    image = post.get('image') or None
    serialized_image = None
    if include_image and isinstance(image, dict) and image.get('data') and image.get('mime_type'):
        serialized_image = {
            'filename': image.get('filename') or 'image',
            'mime_type': image.get('mime_type'),
            'data_uri': 'data:%s;base64,%s' % (image.get('mime_type'), image.get('data')),
        }

    return {
        '_id': str(post.get('_id')),
        'content': post.get('content', ''),
        'created_at': _serialize_datetime(post.get('created_at')),
        'updated_at': _serialize_datetime(post.get('updated_at')),
        'image': serialized_image,
        'has_image': bool(serialized_image),
    }


def _json_error(message, status=400):
    return {'ok': False, 'error': message}, status


def _get_query_value(query, key, default=None):
    if not query or key not in query:
        return default
    value = query.get(key)
    if isinstance(value, list):
        return value[0] if value else default
    return value


def _parse_positive_int(value, default, minimum=1, maximum=None):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    parsed = max(minimum, parsed)
    if maximum is not None:
        parsed = min(maximum, parsed)
    return parsed


def _parse_object_id(value):
    try:
        return ObjectId(value)
    except (InvalidId, TypeError):
        return None


def _validate_content(data):
    if not isinstance(data, dict):
        return None, 'JSON body is required'
    content = data.get('content')
    if not isinstance(content, str):
        return None, 'Content must be text'
    content = content.strip()
    if not content:
        return None, 'Content cannot be empty'
    if len(content) > MAX_CONTENT_LENGTH:
        return None, f'Content must be {MAX_CONTENT_LENGTH} characters or fewer'
    return content, None


def _safe_filename(filename, fallback='image'):
    filename = filename or fallback
    filename = filename.rsplit('/', 1)[-1].rsplit('\\', 1)[-1]
    filename = re.sub(r'[^A-Za-z0-9._-]+', '_', filename).strip('._')
    return filename or fallback


def _extension_for_image(mime_type, filename=None):
    if filename and '.' in filename:
        ext = filename.rsplit('.', 1)[-1].lower()
        if ext in {'jpg', 'jpeg', 'png', 'gif', 'webp'}:
            return '.jpg' if ext == 'jpeg' else '.' + ext
    guessed = mimetypes.guess_extension(mime_type or '') or '.img'
    if guessed == '.jpe':
        guessed = '.jpg'
    return guessed


def _validate_image(data):
    if not isinstance(data, dict) or not data.get('image'):
        return None, None

    image = data.get('image')
    if not isinstance(image, dict):
        return None, 'Image must be an object'

    mime_type = image.get('mime_type') or image.get('type')
    raw_data = image.get('data') or ''
    filename = _safe_filename(image.get('filename') or 'image')

    if not isinstance(mime_type, str) or mime_type not in ALLOWED_IMAGE_TYPES:
        return None, 'Image must be a JPEG, PNG, GIF, or WebP file'
    if not isinstance(raw_data, str) or not raw_data:
        return None, 'Image data is required'

    if raw_data.startswith('data:') and ',' in raw_data:
        raw_data = raw_data.split(',', 1)[1]

    raw_data = ''.join(raw_data.split())

    try:
        decoded = base64.b64decode(raw_data, validate=True)
    except Exception:
        return None, 'Image data is invalid'

    if len(decoded) > MAX_IMAGE_BYTES:
        return None, 'Image must be 5 MB or smaller'

    normalized = base64.b64encode(decoded).decode('ascii')
    return {
        'filename': filename,
        'mime_type': mime_type,
        'data': normalized,
        'size': len(decoded),
    }, None


def _make_export(posts):
    buffer = io.BytesIO()
    text_lines = []
    manifest = []

    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for index, post in enumerate(posts, start=1):
            post_id = str(post.get('_id'))
            content = post.get('content', '')
            one_line = ' '.join(str(content).replace('\r', '\n').splitlines()).strip()
            text_lines.append(one_line)

            entry = {
                'id': post_id,
                'created_at': _serialize_datetime(post.get('created_at')),
                'updated_at': _serialize_datetime(post.get('updated_at')),
                'content': content,
                'image': None,
            }

            image = post.get('image') or None
            if isinstance(image, dict) and image.get('data') and image.get('mime_type'):
                filename = _safe_filename(image.get('filename') or 'image')
                ext = _extension_for_image(image.get('mime_type'), filename)
                stem = filename.rsplit('.', 1)[0] if '.' in filename else filename
                zip_name = f'images/{index:04d}_{post_id}_{_safe_filename(stem)}{ext}'
                try:
                    archive.writestr(zip_name, base64.b64decode(image.get('data')))
                    entry['image'] = zip_name
                except Exception:
                    entry['image'] = None

            manifest.append(entry)

        archive.writestr('feed-text.txt', '\n'.join(text_lines) + ('\n' if text_lines else ''))
        archive.writestr('feed-manifest.json', json.dumps(manifest, indent=2, ensure_ascii=False))

    buffer.seek(0)
    return base64.b64encode(buffer.read()).decode('ascii')


def handle_request(path, method, data, query, db, headers):
    method = (method or 'GET').upper()
    normalized = '/' + (path or '').strip('/')
    if normalized == '/':
        normalized = ''

    posts = db[COLLECTION_NAME]
    posts.create_index([('created_at', -1)])

    if normalized == '/posts':
        if method == 'GET':
            page = _parse_positive_int(_get_query_value(query, 'page', 1), 1)
            limit = _parse_positive_int(_get_query_value(query, 'limit', DEFAULT_LIMIT), DEFAULT_LIMIT, 1, MAX_LIMIT)
            skip = (page - 1) * limit
            total = posts.count_documents({})
            total_pages = max(1, (total + limit - 1) // limit)

            if total and page > total_pages:
                page = total_pages
                skip = (page - 1) * limit

            cursor = posts.find({}).sort('created_at', -1).skip(skip).limit(limit)
            return {
                'ok': True,
                'posts': [_serialize_post(post) for post in cursor],
                'page': page,
                'limit': limit,
                'total': total,
                'total_pages': total_pages,
            }

        if method == 'POST':
            content, error = _validate_content(data)
            if error:
                return _json_error(error)

            image_doc, image_error = _validate_image(data)
            if image_error:
                return _json_error(image_error)

            timestamp = _now()
            document = {
                'content': content,
                'created_at': timestamp,
                'updated_at': timestamp,
            }
            if image_doc:
                document['image'] = image_doc

            result = posts.insert_one(document)
            document['_id'] = result.inserted_id
            return {'ok': True, 'post': _serialize_post(document)}, 201

        return _json_error('Method not allowed', 405)

    if normalized == '/export':
        if method != 'GET':
            return _json_error('Method not allowed', 405)
        all_posts = list(posts.find({}).sort('created_at', 1))
        timestamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
        return {
            'ok': True,
            'filename': f'personal-feed-{timestamp}.zip',
            'mime_type': 'application/zip',
            'data': _make_export(all_posts),
            'count': len(all_posts),
        }

    if normalized.startswith('/posts/'):
        post_id = normalized.split('/', 2)[2]
        object_id = _parse_object_id(post_id)
        if object_id is None:
            return _json_error('Invalid post id', 400)

        if method == 'PUT':
            content, error = _validate_content(data)
            if error:
                return _json_error(error)

            image_doc, image_error = _validate_image(data)
            if image_error:
                return _json_error(image_error)

            update = {
                '$set': {
                    'content': content,
                    'updated_at': _now(),
                }
            }

            if image_doc:
                update['$set']['image'] = image_doc
            elif isinstance(data, dict) and data.get('remove_image'):
                update['$unset'] = {'image': ''}

            updated = posts.find_one_and_update(
                {'_id': object_id},
                update,
                return_document=ReturnDocument.AFTER,
            )
            if not updated:
                return _json_error('Post not found', 404)
            return {'ok': True, 'post': _serialize_post(updated)}

        if method == 'DELETE':
            result = posts.delete_one({'_id': object_id})
            if result.deleted_count == 0:
                return _json_error('Post not found', 404)
            return {'ok': True}

        return _json_error('Method not allowed', 405)

    return {'ok': False, 'error': 'Not found'}, 404
