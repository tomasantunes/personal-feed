const API_BASE = "/api/apps/personal-feed";
const PAGE_SIZE = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

let currentPage = 1;
let totalPages = 1;
let totalPosts = 0;
let editModal;
let searchTimer;
let currentSearch = "";
let editRemoveImage = false;
let postsById = {};

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDate(value) {
  if (!value) return "Unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function setMessage(selector, message, type) {
  const $el = $(selector);
  $el.removeClass("text-danger text-success text-muted");
  if (!message) {
    $el.text("");
    return;
  }
  $el.addClass(type === "success" ? "text-success" : type === "muted" ? "text-muted" : "text-danger");
  $el.text(message);
}

function updateCounts() {
  $("#charCount").text(`${$("#postContent").val().length} / 5000`);
  $("#editCharCount").text(`${$("#editContent").val().length} / 5000`);
}

function parseTags(value) {
  return String(value || "")
    .split(/[\s,]+/)
    .map(tag => tag.trim().replace(/^#+/, "").toLowerCase())
    .filter(Boolean)
    .filter((tag, index, arr) => arr.indexOf(tag) === index);
}

function tagsToInput(tags) {
  return Array.isArray(tags) ? tags.join(", ") : "";
}

function formatFileSize(bytes) {
  if (!bytes) return "0 bytes";
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    payload = { ok: false, error: "Invalid server response" };
  }

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }

  return payload;
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Unable to read image file"));
    reader.readAsDataURL(file);
  });
}

function validateImageFile(file) {
  if (!file) return;
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    throw new Error("Please choose a JPEG, PNG, GIF, or WebP image.");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error("Image must be 5 MB or smaller.");
  }
}

async function buildImagePayload(inputEl) {
  const file = inputEl && inputEl.files && inputEl.files[0];
  if (!file) return null;
  validateImageFile(file);
  const dataUrl = await readFileAsDataURL(file);
  return {
    filename: file.name,
    mime_type: file.type,
    data: String(dataUrl).split(",")[1]
  };
}

function setImagePreview(fileInputSelector, previewSelector, imgSelector, infoSelector, messageSelector) {
  const input = $(fileInputSelector)[0];
  const file = input && input.files && input.files[0];
  const $preview = $(previewSelector);

  if (!file) {
    $preview.addClass("d-none");
    $(imgSelector).attr("src", "");
    $(infoSelector).text("");
    return;
  }

  try {
    validateImageFile(file);
    const url = URL.createObjectURL(file);
    $(imgSelector).attr("src", url);
    $(infoSelector).text(`${file.name} • ${formatFileSize(file.size)}`);
    $preview.removeClass("d-none");
    if (messageSelector) setMessage(messageSelector, "", "muted");
  } catch (error) {
    input.value = "";
    $preview.addClass("d-none");
    if (messageSelector) setMessage(messageSelector, error.message, "danger");
  }
}

function renderTags(tags) {
  if (!Array.isArray(tags) || !tags.length) return "";
  return `<div class="tag-list mt-3">${tags.map(tag => (
    `<button class="tag-chip search-tag" type="button" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</button>`
  )).join("")}</div>`;
}

function renderPosts(posts) {
  postsById = {};
  const $list = $("#postsList").empty();

  if (!posts.length) {
    $("#emptyText").text(currentSearch ? "No posts match your search." : "Create your first post using the textarea above.");
    $("#emptyState").removeClass("d-none");
    return;
  }

  $("#emptyState").addClass("d-none");

  posts.forEach(post => {
    postsById[post._id] = post;
    const updated = post.updated_at && post.updated_at !== post.created_at ? ` • Edited ${formatDate(post.updated_at)}` : "";
    const imageHtml = post.image && post.image.data_uri
      ? `<div class="post-image-wrap mt-3"><img class="post-image" src="${post.image.data_uri}" alt="Attached image from post"></div>`
      : "";

    $list.append(`
      <article class="list-group-item post-item p-4" data-id="${escapeHtml(post._id)}">
        <div class="d-flex flex-wrap justify-content-between gap-2">
          <div class="post-date text-muted">${formatDate(post.created_at)}${updated}</div>
          <div class="post-actions d-flex gap-2">
            <button type="button" class="btn btn-outline-primary btn-sm edit-post" data-id="${escapeHtml(post._id)}">Edit</button>
            <button type="button" class="btn btn-outline-danger btn-sm delete-post" data-id="${escapeHtml(post._id)}">Delete</button>
          </div>
        </div>
        <div class="post-content mt-2">${escapeHtml(post.content)}</div>
        ${imageHtml}
        ${renderTags(post.tags)}
      </article>
    `);
  });
}

function renderPagination() {
  const $pagination = $("#pagination").empty();
  if (totalPages <= 1) return;

  const addItem = (label, page, disabled = false, active = false) => {
    $pagination.append(`
      <li class="page-item ${disabled ? "disabled" : ""} ${active ? "active" : ""}">
        <button class="page-link" type="button" data-page="${page}" ${disabled ? "disabled" : ""}>${label}</button>
      </li>
    `);
  };

  addItem("Previous", Math.max(1, currentPage - 1), currentPage === 1);
  const start = Math.max(1, currentPage - 2);
  const end = Math.min(totalPages, currentPage + 2);
  for (let page = start; page <= end; page += 1) {
    addItem(String(page), page, false, page === currentPage);
  }
  addItem("Next", Math.min(totalPages, currentPage + 1), currentPage === totalPages);
}

function updateFeedMeta() {
  const searchPart = currentSearch ? ` matching “${currentSearch}”` : "";
  $("#feedMeta").text(`${totalPosts} post${totalPosts === 1 ? "" : "s"}${searchPart}`);
}

async function loadPosts(page = 1) {
  currentPage = page;
  $("#loading").removeClass("d-none");
  $("#postsList").empty();
  $("#emptyState").addClass("d-none");

  try {
    const params = new URLSearchParams({ page: String(currentPage), limit: String(PAGE_SIZE) });
    if (currentSearch) params.set("q", currentSearch);
    const payload = await apiRequest(`/posts?${params.toString()}`);
    totalPages = payload.pages || 1;
    totalPosts = payload.total || 0;
    currentPage = payload.page || 1;
    renderPosts(payload.posts || []);
    renderPagination();
    updateFeedMeta();
  } catch (error) {
    setMessage("#formMessage", error.message, "danger");
    $("#feedMeta").text("Unable to load posts");
  } finally {
    $("#loading").addClass("d-none");
  }
}

function resetComposer() {
  $("#postContent").val("");
  $("#postTags").val("");
  $("#postImage").val("");
  $("#postImagePreview").addClass("d-none");
  $("#postImagePreviewImg").attr("src", "");
  $("#postImageInfo").text("");
  updateCounts();
}

function openEditModal(id) {
  const post = postsById[id];
  if (!post) return;
  editRemoveImage = false;
  $("#editId").val(post._id);
  $("#editContent").val(post.content || "");
  $("#editTags").val(tagsToInput(post.tags));
  $("#editImage").val("");
  $("#editImagePreview").addClass("d-none");
  setMessage("#editMessage", "", "muted");

  if (post.image && post.image.data_uri) {
    $("#currentImageImg").attr("src", post.image.data_uri);
    $("#currentImageBox").removeClass("d-none");
    $("#removeCurrentImage").text("Remove current image").prop("disabled", false);
  } else {
    $("#currentImageBox").addClass("d-none");
    $("#currentImageImg").attr("src", "");
  }

  updateCounts();
  editModal.show();
}

async function deletePost(id) {
  if (!confirm("Delete this post? This cannot be undone.")) return;
  try {
    await apiRequest(`/posts/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadPosts(currentPage);
  } catch (error) {
    alert(error.message);
  }
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const chunks = [];
  const chunkSize = 8192;
  for (let i = 0; i < binary.length; i += chunkSize) {
    const slice = binary.slice(i, i + chunkSize);
    const bytes = new Uint8Array(slice.length);
    for (let j = 0; j < slice.length; j += 1) bytes[j] = slice.charCodeAt(j);
    chunks.push(bytes);
  }
  return new Blob(chunks, { type: mimeType || "application/zip" });
}

async function exportFeed() {
  const $btn = $("#exportBtn");
  const oldText = $btn.text();
  $btn.prop("disabled", true).text("Exporting...");
  try {
    const params = new URLSearchParams();
    if (currentSearch) params.set("q", currentSearch);
    const payload = await apiRequest(`/export${params.toString() ? `?${params.toString()}` : ""}`);
    const blob = base64ToBlob(payload.data, payload.mime_type || "application/zip");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = payload.filename || "personal-feed-export.zip";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    alert(error.message);
  } finally {
    $btn.prop("disabled", false).text(oldText);
  }
}

$(function () {
  editModal = new bootstrap.Modal(document.getElementById("editModal"));

  $("#postContent, #editContent").on("input", updateCounts);
  $("#postImage").on("change", () => setImagePreview("#postImage", "#postImagePreview", "#postImagePreviewImg", "#postImageInfo", "#formMessage"));
  $("#editImage").on("change", () => {
    editRemoveImage = false;
    setImagePreview("#editImage", "#editImagePreview", "#editImagePreviewImg", "#editImageInfo", "#editMessage");
  });

  $("#clearPostImage").on("click", () => {
    $("#postImage").val("");
    $("#postImagePreview").addClass("d-none");
  });

  $("#clearEditImage").on("click", () => {
    $("#editImage").val("");
    $("#editImagePreview").addClass("d-none");
  });

  $("#removeCurrentImage").on("click", () => {
    editRemoveImage = true;
    $("#currentImageBox").addClass("d-none");
    setMessage("#editMessage", "Current image will be removed when you save.", "muted");
  });

  $("#postForm").on("submit", async function (event) {
    event.preventDefault();
    setMessage("#formMessage", "Saving...", "muted");
    $("#submitBtn").prop("disabled", true);
    try {
      const image = await buildImagePayload($("#postImage")[0]);
      await apiRequest("/posts", {
        method: "POST",
        body: JSON.stringify({
          content: $("#postContent").val(),
          tags: parseTags($("#postTags").val()),
          image
        })
      });
      resetComposer();
      setMessage("#formMessage", "Post saved.", "success");
      await loadPosts(1);
    } catch (error) {
      setMessage("#formMessage", error.message, "danger");
    } finally {
      $("#submitBtn").prop("disabled", false);
    }
  });

  $("#editForm").on("submit", async function (event) {
    event.preventDefault();
    const id = $("#editId").val();
    setMessage("#editMessage", "Saving...", "muted");
    $("#saveEditBtn").prop("disabled", true);
    try {
      const image = await buildImagePayload($("#editImage")[0]);
      const body = {
        content: $("#editContent").val(),
        tags: parseTags($("#editTags").val()),
        remove_image: editRemoveImage
      };
      if (image) body.image = image;
      await apiRequest(`/posts/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) });
      editModal.hide();
      await loadPosts(currentPage);
    } catch (error) {
      setMessage("#editMessage", error.message, "danger");
    } finally {
      $("#saveEditBtn").prop("disabled", false);
    }
  });

  $("#postsList").on("click", ".edit-post", function () { openEditModal($(this).data("id")); });
  $("#postsList").on("click", ".delete-post", function () { deletePost($(this).data("id")); });
  $("#postsList").on("click", ".search-tag", function () {
    currentSearch = `#${$(this).data("tag")}`;
    $("#searchBox").val(currentSearch);
    loadPosts(1);
  });

  $("#pagination").on("click", ".page-link", function () {
    const page = Number($(this).data("page"));
    if (page && page !== currentPage) loadPosts(page);
  });

  $("#searchBox").on("input", function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      currentSearch = $("#searchBox").val().trim();
      loadPosts(1);
    }, 250);
  });

  $("#refreshBtn").on("click", () => loadPosts(currentPage));
  $("#exportBtn").on("click", exportFeed);

  updateCounts();
  loadPosts(1);
});
