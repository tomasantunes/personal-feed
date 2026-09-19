from datetime import datetime, timezone
import base64
import io
import json
import re
import zipfile
from bson import ObjectId
from bson.errors import InvalidId
from pymongo import ReturnDocument

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


def _serialize_post_for_json_export(post):
    image = post.get("image") or None
    image_meta = None
    if isinstance(image, dict) and image.get("data") and image.get("mime_type"):
        image_meta = {
            "filename": image.get("filename") or "image",
            "mime_type": image.get("mime_type"),
        }
    return {
        "id": str(post.get("_id")),
        "content": post.get("content", ""),
        "tags": post.get("tags", []) if isinstance(post.get("tags"), list) else [],
        "created_at": _serialize_datetime(post.get("created_at")),
        "updated_at": _serialize_datetime(post.get("updated_at")),
        "has_image": bool(image_meta),
        "image": image_meta,
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
        return None, "Tags must be a list or text"

    tags = []
    for candidate in candidates:
        if not isinstance(candidate, str):
            return None, "Each tag must be text"
        tag = candidate.strip().lstrip("#").lower()
        if not tag:
            continue
        if not re.match(r"^[a-z0-9][a-z0-9_-]*$", tag):
            return None, "Tags may contain only letters, numbers, dashes, and underscores"
        if len(tag) > MAX_TAG_LENGTH:
            return None, f"Tags must be {MAX_TAG_LENGTH} characters or fewer"
        if tag not in tags:
            tags.append(tag)
    if len(tags) > MAX_TAGS:
        return None, f"Use {MAX_TAGS} tags or fewer"
    return tags, None


def _safe_filename(filename, fallback="image"):
    filename = filename or fallback
    filename = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    filename = re.sub(r"[^A-Za-z0-9._-]+", "_", filename).strip("._")
    return filename or fallback


def _validate_image_payload(image):
    if image in (None, ""):
        return None, None
    if not isinstance(image, dict):
        return None, "Image must be an object"
    mime_type = image.get("mime_type")
    if mime_type not in ALLOWED_IMAGE_TYPES:
        return None, "Image must be JPEG, PNG, GIF, or WebP"
    data = image.get("data")
    if not isinstance(data, str) or not data:
        return None, "Image data is required"
    try:
        raw = base64.b64decode(data, validate=True)
    except Exception:
        return None, "Image data is not valid base64"
    if len(raw) > MAX_IMAGE_BYTES:
        return None, "Image must be 5 MB or smaller"
    return {
        "filename": _safe_filename(image.get("filename")),
        "mime_type": mime_type,
        "data": base64.b64encode(raw).decode("ascii"),
        "size": len(raw),
    }, None


def _build_search_filter(search):
    search = (search or "").strip()
    if not search:
        return {}

    terms = [term.strip() for term in re.split(r"[\s,]+", search) if term.strip()]
    tag_terms = []
    plain_terms = []
    for term in terms:
        if term.startswith("#"):
            tag_terms.append(term.lstrip("#").lower())
        elif term.lower().startswith("tag:"):
            tag_terms.append(term.split(":", 1)[1].lstrip("#").lower())
        else:
            plain_terms.append(term)

    clauses = []
    for tag in tag_terms:
        if tag:
            clauses.append({"tags": tag})
    for term in plain_terms:
        escaped = re.escape(term)
        clauses.append({"content": {"$regex": escaped, "$options": "i"}})
        clauses.append({"tags": {"$regex": escaped, "$options": "i"}})

    if not clauses:
        return {}
    return {"$or": clauses}


def _posts_collection(db):
    collection = db[COLLECTION_NAME]
    collection.create_index([("created_at", -1)])
    collection.create_index("tags")
    return collection


def _list_posts(db, query):
    collection = _posts_collection(db)
    page = _parse_positive_int(_get_query_value(query, "page", 1), 1)
    limit = _parse_positive_int(_get_query_value(query, "limit", DEFAULT_LIMIT), DEFAULT_LIMIT, maximum=MAX_LIMIT)
    search = str(_get_query_value(query, "q", "") or "").strip()
    filter_doc = _build_search_filter(search)
    total = collection.count_documents(filter_doc)
    total_pages = max(1, (total + limit - 1) // limit)
    page = min(page, total_pages)
    posts = list(collection.find(filter_doc).sort("created_at", -1).skip((page - 1) * limit).limit(limit))
    return {
        "ok": True,
        "posts": [_serialize_post(post) for post in posts],
        "page": page,
        "limit": limit,
        "total": total,
        "total_pages": total_pages,
    }


def _create_post(db, data):
    content, error = _validate_content(data)
    if error:
        return _json_error(error)
    tags, tag_error = _normalize_tags(data.get("tags"))
    if tag_error:
        return _json_error(tag_error)
    image, image_error = _validate_image_payload(data.get("image"))
    if image_error:
        return _json_error(image_error)

    now = _now()
    doc = {
        "content": content,
        "tags": tags,
        "created_at": now,
        "updated_at": now,
    }
    if image:
        doc["image"] = image
    result = _posts_collection(db).insert_one(doc)
    post = _posts_collection(db).find_one({"_id": result.inserted_id})
    return {"ok": True, "post": _serialize_post(post)}, 201


def _update_post(db, post_id, data):
    object_id = _parse_object_id(post_id)
    if object_id is None:
        return _json_error("Invalid post id", 404)
    content, error = _validate_content(data)
    if error:
        return _json_error(error)
    tags, tag_error = _normalize_tags(data.get("tags"))
    if tag_error:
        return _json_error(tag_error)
    image, image_error = _validate_image_payload(data.get("image"))
    if image_error:
        return _json_error(image_error)

    update = {"$set": {"content": content, "tags": tags, "updated_at": _now()}}
    unset = {}
    if image:
        update["$set"]["image"] = image
    elif data.get("remove_image"):
        unset["image"] = ""
    if unset:
        update["$unset"] = unset

    post = _posts_collection(db).find_one_and_update(
        {"_id": object_id}, update, return_document=ReturnDocument.AFTER
    )
    if not post:
        return _json_error("Post not found", 404)
    return {"ok": True, "post": _serialize_post(post)}


def _delete_post(db, post_id):
    object_id = _parse_object_id(post_id)
    if object_id is None:
        return _json_error("Invalid post id", 404)
    result = _posts_collection(db).delete_one({"_id": object_id})
    if result.deleted_count == 0:
        return _json_error("Post not found", 404)
    return {"ok": True}


def _export_posts(db):
    posts = list(_posts_collection(db).find({}).sort("created_at", -1))
    exported = [_serialize_post_for_json_export(post) for post in posts]
    txt_lines = []
    for post in exported:
        txt_lines.append(post["created_at"] or "Unknown date")
        if post.get("tags"):
            txt_lines.append("Tags: " + ", ".join("#" + tag for tag in post["tags"]))
        txt_lines.append(post.get("content", ""))
        txt_lines.append("-" * 40)

    memory = io.BytesIO()
    with zipfile.ZipFile(memory, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("posts.json", json.dumps(exported, indent=2, ensure_ascii=False))
        archive.writestr("posts.txt", "\n".join(txt_lines))
    memory.seek(0)
    filename = "personal-feed-export-%s.zip" % _now().strftime("%Y%m%d-%H%M%S")
    return {
        "ok": True,
        "filename": filename,
        "content_type": "application/zip",
        "data_base64": base64.b64encode(memory.read()).decode("ascii"),
    }


def handle_request(path, method, data, query, db, headers):
    normalized_path = _normalize_path(path)
    method = str(method or "GET").upper()

    if normalized_path == "/posts":
        if method == "GET":
            return _list_posts(db, query)
        if method == "POST":
            return _create_post(db, data or {})
        return _json_error("Method not allowed", 405)

    match = re.match(r"^/posts/([A-Fa-f0-9]{24})$", normalized_path)
    if match:
        post_id = match.group(1)
        if method in ("PUT", "PATCH"):
            return _update_post(db, post_id, data or {})
        if method == "DELETE":
            return _delete_post(db, post_id)
        return _json_error("Method not allowed", 405)

    if normalized_path == "/export":
        if method == "GET":
            return _export_posts(db)
        return _json_error("Method not allowed", 405)

    return {"ok": False, "error": "Not found"}, 404
