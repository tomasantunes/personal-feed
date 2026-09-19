from datetime import datetime, timezone
import base64
import io
import json
import math
import re
import zipfile
from bson import ObjectId
from bson.errors import InvalidId
from pymongo import DESCENDING, ReturnDocument

COLLECTION_NAME = "personal_feed_posts"
MAX_CONTENT_LENGTH = 5000
MAX_IMAGE_BYTES = 5 * 1024 * 1024
DEFAULT_LIMIT = 8
MAX_LIMIT = 50
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
MAX_TAGS = 20
MAX_TAG_LENGTH = 32


def _now():
    return datetime.now(timezone.utc)


def _serialize_datetime(value):
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return value


def _serialize_post(post, include_image=True):
    image = post.get("image") or None
    serialized_image = None
    if include_image and isinstance(image, dict) and image.get("data") and image.get("mime_type"):
        serialized_image = {
            "filename": image.get("filename") or "image",
            "mime_type": image.get("mime_type"),
            "data_uri": "data:%s;base64,%s" % (image.get("mime_type"), image.get("data")),
        }

    return {
        "_id": str(post.get("_id")),
        "content": post.get("content", ""),
        "tags": post.get("tags", []) if isinstance(post.get("tags"), list) else [],
        "created_at": _serialize_datetime(post.get("created_at")),
        "updated_at": _serialize_datetime(post.get("updated_at")),
        "image": serialized_image,
        "has_image": bool(serialized_image),
    }


def _json_error(message, status=400):
    return {"ok": False, "error": message}, status


def _normalize_path(path):
    path = str(path or "")
    prefixes = ["/api/apps/personal-feed", "api/apps/personal-feed"]
    for prefix in prefixes:
        if path.startswith(prefix):
            path = path[len(prefix):]
            break
    if not path.startswith("/"):
        path = "/" + path
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]
    return path


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
        return None, "JSON body is required"
    content = data.get("content")
    if not isinstance(content, str):
        return None, "Content must be text"
    content = content.strip()
    if not content:
        return None, "Content cannot be empty"
    if len(content) > MAX_CONTENT_LENGTH:
        return None, f"Content must be {MAX_CONTENT_LENGTH} characters or fewer"
    return content, None


def _normalize_tags(raw_tags):
    if raw_tags is None:
        return []
    if isinstance(raw_tags, str):
        candidates = re.split(r"[\s,]+", raw_tags)
    elif isinstance(raw_tags, list):
        candidates = raw_tags
    else:
        return []

    tags = []
    seen = set()
    for raw in candidates:
        tag = str(raw or "").strip().lstrip("#").lower()
        tag = re.sub(r"[^a-z0-9_-]", "", tag)
        if not tag:
            continue
        tag = tag[:MAX_TAG_LENGTH]
        if tag not in seen:
            seen.add(tag)
            tags.append(tag)
        if len(tags) >= MAX_TAGS:
            break
    return tags


def _sanitize_filename(filename):
    filename = str(filename or "image").strip().replace("\\", "_").replace("/", "_")
    filename = re.sub(r"[^A-Za-z0-9._ -]", "_", filename)
    filename = filename.strip(" .") or "image"
    return filename[:120]


def _image_extension(mime_type):
    return {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/gif": ".gif",
        "image/webp": ".webp",
    }.get(mime_type, "")


def _validate_image(raw_image):
    if raw_image in (None, ""):
        return None, None
    if not isinstance(raw_image, dict):
        return None, "Image must be an object"

    mime_type = raw_image.get("mime_type") or raw_image.get("type")
    if mime_type not in ALLOWED_IMAGE_TYPES:
        return None, "Image must be JPEG, PNG, GIF, or WebP"

    data = raw_image.get("data") or ""
    if isinstance(data, str) and data.startswith("data:"):
        data = data.split(",", 1)[-1]
    if not isinstance(data, str) or not data:
        return None, "Image data is required"

    try:
        decoded = base64.b64decode(data, validate=True)
    except Exception:
        return None, "Image data is not valid base64"

    if len(decoded) > MAX_IMAGE_BYTES:
        return None, "Image must be 5 MB or smaller"

    filename = _sanitize_filename(raw_image.get("filename") or "image" + _image_extension(mime_type))
    if "." not in filename and _image_extension(mime_type):
        filename += _image_extension(mime_type)

    return {
        "filename": filename,
        "mime_type": mime_type,
        "data": base64.b64encode(decoded).decode("ascii"),
        "size": len(decoded),
    }, None


def _build_filter(query):
    q = str(_get_query_value(query, "q", "") or "").strip()
    if not q:
        return {}, ""

    term = q[1:].strip().lower() if q.startswith("#") else q
    if q.startswith("#"):
        return {"tags": term}, q

    safe = re.escape(term)
    return {
        "$or": [
            {"content": {"$regex": safe, "$options": "i"}},
            {"tags": {"$regex": safe, "$options": "i"}},
        ]
    }, q


def _ensure_indexes(collection):
    try:
        collection.create_index([("created_at", DESCENDING)])
        collection.create_index("tags")
    except Exception:
        pass


def _list_posts(collection, query):
    page = _parse_positive_int(_get_query_value(query, "page", 1), 1)
    limit = _parse_positive_int(_get_query_value(query, "limit", DEFAULT_LIMIT), DEFAULT_LIMIT, maximum=MAX_LIMIT)
    filt, q = _build_filter(query)
    total = collection.count_documents(filt)
    pages = max(1, int(math.ceil(total / float(limit))))
    page = min(page, pages)
    skip = (page - 1) * limit
    docs = list(collection.find(filt).sort("created_at", DESCENDING).skip(skip).limit(limit))
    return {
        "ok": True,
        "posts": [_serialize_post(doc, include_image=True) for doc in docs],
        "page": page,
        "limit": limit,
        "total": total,
        "pages": pages,
        "q": q,
    }


def _create_post(collection, data):
    content, error = _validate_content(data)
    if error:
        return _json_error(error)
    image, image_error = _validate_image(data.get("image"))
    if image_error:
        return _json_error(image_error)

    timestamp = _now()
    doc = {
        "content": content,
        "tags": _normalize_tags(data.get("tags")),
        "created_at": timestamp,
        "updated_at": timestamp,
    }
    if image:
        doc["image"] = image

    result = collection.insert_one(doc)
    created = collection.find_one({"_id": result.inserted_id})
    return {"ok": True, "post": _serialize_post(created, include_image=True)}, 201


def _get_post(collection, post_id):
    object_id = _parse_object_id(post_id)
    if not object_id:
        return _json_error("Invalid post id", 400)
    post = collection.find_one({"_id": object_id})
    if not post:
        return _json_error("Post not found", 404)
    return {"ok": True, "post": _serialize_post(post, include_image=True)}


def _update_post(collection, post_id, data):
    object_id = _parse_object_id(post_id)
    if not object_id:
        return _json_error("Invalid post id", 400)

    content, error = _validate_content(data)
    if error:
        return _json_error(error)

    update_set = {
        "content": content,
        "tags": _normalize_tags(data.get("tags")),
        "updated_at": _now(),
    }
    update_doc = {"$set": update_set}

    if data.get("image") not in (None, ""):
        image, image_error = _validate_image(data.get("image"))
        if image_error:
            return _json_error(image_error)
        update_set["image"] = image
    elif data.get("remove_image") is True:
        update_doc["$unset"] = {"image": ""}

    post = collection.find_one_and_update(
        {"_id": object_id},
        update_doc,
        return_document=ReturnDocument.AFTER,
    )
    if not post:
        return _json_error("Post not found", 404)
    return {"ok": True, "post": _serialize_post(post, include_image=True)}


def _delete_post(collection, post_id):
    object_id = _parse_object_id(post_id)
    if not object_id:
        return _json_error("Invalid post id", 400)
    result = collection.delete_one({"_id": object_id})
    if result.deleted_count == 0:
        return _json_error("Post not found", 404)
    return {"ok": True}


def _post_export_record(post, image_path=None):
    return {
        "id": str(post.get("_id")),
        "content": post.get("content", ""),
        "tags": post.get("tags", []) if isinstance(post.get("tags"), list) else [],
        "created_at": _serialize_datetime(post.get("created_at")),
        "updated_at": _serialize_datetime(post.get("updated_at")),
        "image_path": image_path,
    }


def _export_posts(collection, query):
    filt, q = _build_filter(query)
    posts = list(collection.find(filt).sort("created_at", DESCENDING))

    zip_buffer = io.BytesIO()
    export_records = []
    text_lines = ["Personal Feed Export", "Generated: %s" % _now().isoformat(), "Search: %s" % (q or "all posts"), "", ""]

    with zipfile.ZipFile(zip_buffer, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        used_image_names = set()

        for index, post in enumerate(posts, start=1):
            image_path = None
            image = post.get("image") or None
            if isinstance(image, dict) and image.get("data") and image.get("mime_type"):
                try:
                    image_bytes = base64.b64decode(image.get("data"), validate=True)
                    base_name = _sanitize_filename(image.get("filename") or ("image" + _image_extension(image.get("mime_type"))))
                    if "." not in base_name and _image_extension(image.get("mime_type")):
                        base_name += _image_extension(image.get("mime_type"))
                    stem, dot, ext = base_name.rpartition(".")
                    if not dot:
                        stem, ext = base_name, _image_extension(image.get("mime_type")).lstrip(".")
                    candidate = "images/%03d_%s.%s" % (index, stem or "image", ext or "bin")
                    counter = 2
                    while candidate in used_image_names:
                        candidate = "images/%03d_%s_%d.%s" % (index, stem or "image", counter, ext or "bin")
                        counter += 1
                    used_image_names.add(candidate)
                    zf.writestr(candidate, image_bytes)
                    image_path = candidate
                except Exception:
                    image_path = None

            export_records.append(_post_export_record(post, image_path=image_path))
            text_lines.append("Post %d" % index)
            text_lines.append("ID: %s" % str(post.get("_id")))
            text_lines.append("Created: %s" % _serialize_datetime(post.get("created_at")))
            text_lines.append("Updated: %s" % _serialize_datetime(post.get("updated_at")))
            tags = post.get("tags") if isinstance(post.get("tags"), list) else []
            text_lines.append("Tags: %s" % (", ".join(tags) if tags else ""))
            if image_path:
                text_lines.append("Image: %s" % image_path)
            text_lines.append("")
            text_lines.append(post.get("content", ""))
            text_lines.append("")
            text_lines.append("-" * 72)
            text_lines.append("")

        manifest = {
            "ok": True,
            "generated_at": _now().isoformat(),
            "search": q,
            "count": len(export_records),
            "posts": export_records,
        }
        zf.writestr("personal-feed.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        zf.writestr("personal-feed.txt", "\n".join(text_lines))
        zf.writestr("README.txt", "This ZIP export includes personal-feed.json, personal-feed.txt, and any attached images in the images/ folder.\n")

    encoded = base64.b64encode(zip_buffer.getvalue()).decode("ascii")
    timestamp = _now().strftime("%Y%m%d-%H%M%S")
    return {
        "ok": True,
        "filename": "personal-feed-export-%s.zip" % timestamp,
        "mime_type": "application/zip",
        "data": encoded,
        "count": len(posts),
    }


def handle_request(path, method, data, query, db, headers):
    method = str(method or "GET").upper()
    path = _normalize_path(path)
    collection = db[COLLECTION_NAME]
    _ensure_indexes(collection)

    if path == "/posts":
        if method == "GET":
            return _list_posts(collection, query)
        if method == "POST":
            return _create_post(collection, data or {})
        return _json_error("Method not allowed", 405)

    match = re.match(r"^/posts/([a-fA-F0-9]{24})$", path)
    if match:
        post_id = match.group(1)
        if method == "GET":
            return _get_post(collection, post_id)
        if method == "PUT":
            return _update_post(collection, post_id, data or {})
        if method == "DELETE":
            return _delete_post(collection, post_id)
        return _json_error("Method not allowed", 405)

    if path == "/export":
        if method in ("GET", "POST"):
            return _export_posts(collection, query or {})
        return _json_error("Method not allowed", 405)

    return {"ok": False, "error": "Not found"}, 404
