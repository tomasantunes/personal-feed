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

    try:
        decoded = base64.b64decode(raw_data, validate=True)
    except Exception:
        return None, 'Image data must be valid base64'

    if len(decoded) > MAX_IMAGE_BYTES:
        return None, 'Image must be 5 MB or smaller'

    return {
        'filename': filename,
        'mime_type': mime_type,
        'data': base64.b64encode(decoded).decode('ascii'),
        'size': len(decoded),
    }, None


def _collection(db):
    collection = db[COLLECTION_NAME]
    try:
        collection.create_index([('created_at', -1)])
        collection.create_index([('content', 'text')])
    except Exception:
        pass
    return collection


def _normalize_path(path):
    path = path or '/'
    if '?' in path:
        path = path.split('?', 1)[0]
    if not path.startswith('/'):
        path = '/' + path
    if path != '/' and path.endswith('/'):
        path = path.rstrip('/')
    return path


def _search_filter(query):
    q = _get_query_value(query, 'q', '')
    if not isinstance(q, str):
        q = str(q or '')
    q = q.strip()
    if not q:
        return {}, ''
    return {'content': {'$regex': re.escape(q), '$options': 'i'}}, q


def _list_posts(db, query):
    collection = _collection(db)
    page = _parse_positive_int(_get_query_value(query, 'page', 1), 1)
    limit = _parse_positive_int(_get_query_value(query, 'limit', DEFAULT_LIMIT), DEFAULT_LIMIT, maximum=MAX_LIMIT)
    search_filter, q = _search_filter(query)

    total = collection.count_documents(search_filter)
    total_pages = max(1, (total + limit - 1) // limit)
    page = min(page, total_pages)
    skip = (page - 1) * limit

    cursor = collection.find(search_filter).sort('created_at', -1).skip(skip).limit(limit)
    posts = [_serialize_post(post) for post in cursor]
    return {
        'ok': True,
        'posts': posts,
        'page': page,
        'limit': limit,
        'total': total,
        'total_pages': total_pages,
        'query': q,
    }


def _create_post(db, data):
    content, error = _validate_content(data)
    if error:
        return _json_error(error)

    image, image_error = _validate_image(data)
    if image_error:
        return _json_error(image_error)

    now = _now()
    document = {
        'content': content,
        'created_at': now,
        'updated_at': now,
    }
    if image:
        document['image'] = image

    result = _collection(db).insert_one(document)
    document['_id'] = result.inserted_id
    return {'ok': True, 'post': _serialize_post(document)}, 201


def _update_post(db, post_id, data):
    oid = _parse_object_id(post_id)
    if oid is None:
        return _json_error('Invalid post id', 400)

    content, error = _validate_content(data)
    if error:
        return _json_error(error)

    image, image_error = _validate_image(data)
    if image_error:
        return _json_error(image_error)

    update = {
        '$set': {
            'content': content,
            'updated_at': _now(),
        }
    }

    if image:
        update['$set']['image'] = image
    elif isinstance(data, dict) and data.get('remove_image'):
        update['$unset'] = {'image': ''}

    post = _collection(db).find_one_and_update(
        {'_id': oid},
        update,
        return_document=ReturnDocument.AFTER,
    )
    if not post:
        return _json_error('Post not found', 404)
    return {'ok': True, 'post': _serialize_post(post)}


def _delete_post(db, post_id):
    oid = _parse_object_id(post_id)
    if oid is None:
        return _json_error('Invalid post id', 400)
    result = _collection(db).delete_one({'_id': oid})
    if result.deleted_count == 0:
        return _json_error('Post not found', 404)
    return {'ok': True, 'deleted': True}


def _export_posts(db):
    collection = _collection(db)
    posts = list(collection.find({}).sort('created_at', -1))
    export_posts = []

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
        for index, post in enumerate(posts, start=1):
            serialized = _serialize_post(post, include_image=False)
            image = post.get('image') or None
            if isinstance(image, dict) and image.get('data') and image.get('mime_type'):
                ext = _extension_for_image(image.get('mime_type'), image.get('filename'))
                image_name = f'images/{index:04d}_{str(post.get("_id"))}{ext}'
                try:
                    zf.writestr(image_name, base64.b64decode(image.get('data')))
                    serialized['image_file'] = image_name
                    serialized['image_filename'] = image.get('filename') or 'image'
                    serialized['image_mime_type'] = image.get('mime_type')
                except Exception:
                    serialized['image_file_error'] = 'Unable to export image'
            export_posts.append(serialized)

        zf.writestr('posts.json', json.dumps(export_posts, indent=2, ensure_ascii=False))
        zf.writestr('README.txt', 'Personal Feed export. Posts are in posts.json. Images, if any, are in the images folder.\n')

    encoded = base64.b64encode(buffer.getvalue()).decode('ascii')
    filename = 'personal-feed-export-%s.zip' % datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
    return {
        'ok': True,
        'filename': filename,
        'zip_base64': encoded,
        'count': len(posts),
    }


def handle_request(path, method, data, query, db, headers):
    path = _normalize_path(path)
    method = (method or 'GET').upper()

    if path == '/posts':
        if method == 'GET':
            return _list_posts(db, query)
        if method == 'POST':
            return _create_post(db, data)
        return _json_error('Method not allowed', 405)

    if path.startswith('/posts/'):
        post_id = path.split('/', 2)[2]
        if not post_id:
            return {'ok': False, 'error': 'Not found'}, 404
        if method == 'PUT':
            return _update_post(db, post_id, data)
        if method == 'DELETE':
            return _delete_post(db, post_id)
        return _json_error('Method not allowed', 405)

    if path == '/export':
        if method == 'GET':
            return _export_posts(db)
        return _json_error('Method not allowed', 405)

    return {'ok': False, 'error': 'Not found'}, 404
