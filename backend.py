from datetime import datetime, timezone
import base64
import io
import json
import math
import re
import zipfile
from bson import ObjectId
from bson.errors import InvalidId
from pymongo import DESCENDING

COLLECTION_NAME = 'personal_feed_posts'
MAX_CONTENT_LENGTH = 5000
MAX_IMAGE_BYTES = 5 * 1024 * 1024
DEFAULT_LIMIT = 8
MAX_LIMIT = 50
ALLOWED_IMAGE_TYPES = {'image/jpeg', 'image/png', 'image/gif', 'image/webp'}
MAX_TAGS = 20
MAX_TAG_LENGTH = 32
_INDEXES_DONE = False


def _now():
    return datetime.now(timezone.utc)


def _ensure_indexes(collection):
    global _INDEXES_DONE
    if _INDEXES_DONE:
        return
    collection.create_index([('created_at', DESCENDING)])
    collection.create_index([('updated_at', DESCENDING)])
    collection.create_index('tags')
    _INDEXES_DONE = True


def _normalize_path(path):
    path = str(path or '')
    for prefix in ('/api/apps/personal-feed', 'api/apps/personal-feed'):
        if path.startswith(prefix):
            path = path[len(prefix):]
            break
    if not path.startswith('/'):
        path = '/' + path
    if len(path) > 1 and path.endswith('/'):
        path = path[:-1]
    return path


def _query_value(query, key, default=None):
    if not query or key not in query:
        return default
    value = query.get(key)
    if isinstance(value, list):
        return value[0] if value else default
    return value


def _positive_int(value, default, minimum=1, maximum=None):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    parsed = max(minimum, parsed)
    if maximum is not None:
        parsed = min(maximum, parsed)
    return parsed


def _object_id(value):
    try:
        return ObjectId(str(value))
    except (InvalidId, TypeError, ValueError):
        return None


def _json_error(message, status=400):
    return {'ok': False, 'error': message}, status


def _serialize_datetime(value):
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return value


def _serialize_post(post, include_image=True, image_path=None):
    image = post.get('image') if isinstance(post.get('image'), dict) else None
    serialized_image = None
    if image and image.get('mime_type'):
        serialized_image = {
            'filename': image.get('filename') or 'image',
            'mime_type': image.get('mime_type'),
            'bytes': image.get('bytes') or 0,
        }
        if image_path:
            serialized_image['path'] = image_path
        elif include_image and image.get('data'):
            serialized_image['data_uri'] = 'data:%s;base64,%s' % (image.get('mime_type'), image.get('data'))
    return {
        '_id': str(post.get('_id')),
        'content': post.get('content', ''),
        'tags': post.get('tags', []) if isinstance(post.get('tags'), list) else [],
        'created_at': _serialize_datetime(post.get('created_at')),
        'updated_at': _serialize_datetime(post.get('updated_at')),
        'image': serialized_image,
        'has_image': bool(image and image.get('data') and image.get('mime_type')),
    }


def _normalize_tags(raw_tags):
    if raw_tags is None:
        return []
    if isinstance(raw_tags, str):
        candidates = re.split(r'[\s,]+', raw_tags)
    elif isinstance(raw_tags, list):
        candidates = raw_tags
    else:
        return []
    tags = []
    seen = set()
    for raw in candidates:
        tag = str(raw or '').strip().lstrip('#').lower()
        tag = re.sub(r'[^a-z0-9_-]', '', tag)
        if not tag or tag in seen:
            continue
        if len(tag) > MAX_TAG_LENGTH:
            tag = tag[:MAX_TAG_LENGTH]
        tags.append(tag)
        seen.add(tag)
        if len(tags) >= MAX_TAGS:
            break
    return tags


def _validate_content(data):
    content = data.get('content') if isinstance(data, dict) else None
    if not isinstance(content, str):
        return None, 'Content must be text'
    content = content.strip()
    if not content:
        return None, 'Content cannot be empty'
    if len(content) > MAX_CONTENT_LENGTH:
        return None, 'Content must be 5000 characters or fewer'
    return content, None


def _validate_image(raw_image):
    if not raw_image:
        return None, None
    if not isinstance(raw_image, dict):
        return None, 'Image payload is invalid'
    mime_type = str(raw_image.get('mime_type') or '').lower().strip()
    if mime_type not in ALLOWED_IMAGE_TYPES:
        return None, 'Image must be a JPEG, PNG, GIF, or WebP file'
    data = str(raw_image.get('data') or '').strip()
    if ',' in data and data.startswith('data:'):
        data = data.split(',', 1)[1]
    try:
        decoded = base64.b64decode(data, validate=True)
    except Exception:
        return None, 'Image data is not valid base64'
    if len(decoded) > MAX_IMAGE_BYTES:
        return None, 'Image must be 5 MB or smaller'
    filename = str(raw_image.get('filename') or 'image').strip()[:120]
    filename = re.sub(r'[^A-Za-z0-9._ -]', '_', filename) or 'image'
    return {'filename': filename, 'mime_type': mime_type, 'data': base64.b64encode(decoded).decode('ascii'), 'bytes': len(decoded)}, None


def _search_filter(search):
    search = str(search or '').strip()
    if not search:
        return {}
    term = search.lstrip('#')
    pattern = re.escape(term)
    return {'$or': [{'content': {'$regex': pattern, '$options': 'i'}}, {'tags': {'$regex': pattern, '$options': 'i'}}]}


def _safe_zip_name(value, fallback):
    name = re.sub(r'[^A-Za-z0-9._-]', '_', str(value or fallback)).strip('._')
    return name or fallback


def _extension_for(mime_type):
    return {'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp'}.get(mime_type, '')


def _list_posts(collection, query):
    page = _positive_int(_query_value(query, 'page', 1), 1)
    limit = _positive_int(_query_value(query, 'limit', DEFAULT_LIMIT), DEFAULT_LIMIT, maximum=MAX_LIMIT)
    search = str(_query_value(query, 'q', '') or '').strip()
    criteria = _search_filter(search)
    total = collection.count_documents(criteria)
    total_pages = max(1, int(math.ceil(total / float(limit)))) if total else 1
    if page > total_pages:
        page = total_pages
    cursor = collection.find(criteria).sort('created_at', DESCENDING).skip((page - 1) * limit).limit(limit)
    return {'ok': True, 'posts': [_serialize_post(post) for post in cursor], 'page': page, 'limit': limit, 'total': total, 'total_pages': total_pages, 'search': search}


def _create_post(collection, data):
    content, error = _validate_content(data)
    if error:
        return _json_error(error)
    image, image_error = _validate_image(data.get('image') if isinstance(data, dict) else None)
    if image_error:
        return _json_error(image_error)
    now = _now()
    doc = {'content': content, 'tags': _normalize_tags(data.get('tags') if isinstance(data, dict) else None), 'created_at': now, 'updated_at': now}
    if image:
        doc['image'] = image
    result = collection.insert_one(doc)
    doc['_id'] = result.inserted_id
    return {'ok': True, 'post': _serialize_post(doc)}, 201


def _update_post(collection, post_id, data):
    oid = _object_id(post_id)
    if not oid:
        return _json_error('Invalid post id', 400)
    existing = collection.find_one({'_id': oid})
    if not existing:
        return _json_error('Post not found', 404)
    content, error = _validate_content(data)
    if error:
        return _json_error(error)
    update = {'content': content, 'tags': _normalize_tags(data.get('tags') if isinstance(data, dict) else None), 'updated_at': _now()}
    unset = {}
    if isinstance(data, dict) and data.get('remove_image'):
        unset['image'] = ''
    elif isinstance(data, dict) and data.get('image'):
        image, image_error = _validate_image(data.get('image'))
        if image_error:
            return _json_error(image_error)
        update['image'] = image
    operation = {'$set': update}
    if unset:
        operation['$unset'] = unset
    collection.update_one({'_id': oid}, operation)
    updated = collection.find_one({'_id': oid})
    return {'ok': True, 'post': _serialize_post(updated)}


def _delete_post(collection, post_id):
    oid = _object_id(post_id)
    if not oid:
        return _json_error('Invalid post id', 400)
    result = collection.delete_one({'_id': oid})
    if result.deleted_count == 0:
        return _json_error('Post not found', 404)
    return {'ok': True}


def _export_zip(collection):
    posts = list(collection.find({}).sort('created_at', DESCENDING))
    exported_at = _now().isoformat()
    json_posts = []
    txt_lines = []
    memory = io.BytesIO()
    with zipfile.ZipFile(memory, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('images/', '')
        for index, post in enumerate(posts, start=1):
            image_path = None
            image = post.get('image') if isinstance(post.get('image'), dict) else None
            if image and image.get('data') and image.get('mime_type'):
                filename = _safe_zip_name(image.get('filename'), 'image')
                if '.' not in filename:
                    filename += _extension_for(image.get('mime_type'))
                image_path = 'images/%03d_%s' % (index, filename)
                try:
                    archive.writestr(image_path, base64.b64decode(image.get('data')))
                except Exception:
                    image_path = None
            json_posts.append(_serialize_post(post, include_image=False, image_path=image_path))
            one_line = re.sub(r'\s+', ' ', str(post.get('content', '')).strip())
            if one_line:
                txt_lines.append(one_line)
        manifest = {'exported_at': exported_at, 'count': len(json_posts), 'posts': json_posts}
        archive.writestr('personal-feed.json', json.dumps(manifest, ensure_ascii=False, indent=2))
        archive.writestr('posts.txt', '\n'.join(txt_lines) + ('\n' if txt_lines else ''))
    encoded = base64.b64encode(memory.getvalue()).decode('ascii')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
    return {'ok': True, 'filename': 'personal-feed-export-%s.zip' % stamp, 'mime_type': 'application/zip', 'data': encoded, 'count': len(posts)}


def handle_request(path, method, data, query, db, headers):
    collection = db[COLLECTION_NAME]
    _ensure_indexes(collection)
    path = _normalize_path(path)
    method = str(method or 'GET').upper()
    data = data if isinstance(data, dict) else {}

    if path == '/posts' and method == 'GET':
        return _list_posts(collection, query)
    if path == '/posts' and method == 'POST':
        return _create_post(collection, data)
    if path == '/export' and method == 'GET':
        return _export_zip(collection)

    match = re.match(r'^/posts/([^/]+)$', path)
    if match:
        post_id = match.group(1)
        if method == 'GET':
            oid = _object_id(post_id)
            if not oid:
                return _json_error('Invalid post id', 400)
            post = collection.find_one({'_id': oid})
            if not post:
                return _json_error('Post not found', 404)
            return {'ok': True, 'post': _serialize_post(post)}
        if method == 'PUT':
            return _update_post(collection, post_id, data)
        if method == 'DELETE':
            return _delete_post(collection, post_id)

    return {'ok': False, 'error': 'Not found'}, 404
