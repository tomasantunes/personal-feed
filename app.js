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
  return `<div class="tag-list mt-3">${tags.map(tag => `<button type="button" class="tag-chip js-tag-search" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</button>`).join("")}</div>`;
}

function renderPosts(posts) {
  const $list = $("#postsList");
  $list.empty();
  postsById = {};

  if (!posts.length) {
    $("#emptyState").removeClass("d-none");
    $("#emptyText").text(currentSearch ? `No posts match “${currentSearch}”. Try a different word or tag.` : "Create your first post using the textarea above.");
    return;
  }

  $("#emptyState").addClass("d-none");

  posts.forEach(post => {
    postsById[post._id] = post;
    const imageHtml = post.image && post.image.data_uri
      ? `<div class="post-image-wrap mt-3"><img class="post-image" src="${post.image.data_uri}" alt="${escapeHtml(post.image.filename || "Post image")}"></div>`
      : "";
    const updated = post.updated_at && post.updated_at !== post.created_at ? ` <span class="text-muted">• edited ${formatDate(post.updated_at)}</span>` : "";
    const item = `
      <article class="list-group-item post-item p-4" data-id="${escapeHtml(post._id)}">
        <div class="d-flex flex-wrap justify-content-between align-items-start gap-2">
          <div class="post-date text-muted">${formatDate(post.created_at)}${updated}</div>
          <div class="post-actions d-flex gap-2">
            <button type="button" class="btn btn-outline-primary btn-sm edit-post" data-id="${escapeHtml(post._id)}">Edit</button>
            <button type="button" class="btn btn-outline-danger btn-sm delete-post" data-id="${escapeHtml(post._id)}">Delete</button>
          </div>
        </div>
        <div class="post-content mt-2">${escapeHtml(post.content)}</div>
        ${renderTags(post.tags)}
        ${imageHtml}
      </article>`;
    $list.append(item);
  });
}

function renderPagination() {
  const $pagination = $("#pagination");
  $pagination.empty();
  if (totalPages <= 1) return;

  function pageItem(label, page, disabled = false, active = false) {
    const classes = ["page-item", disabled ? "disabled" : "", active ? "active" : ""].filter(Boolean).join(" ");
    return `<li class="${classes}"><button class="page-link" type="button" data-page="${page}" ${disabled ? "disabled" : ""}>${label}</button></li>`;
  }

  $pagination.append(pageItem("Previous", currentPage - 1, currentPage <= 1));
  const start = Math.max(1, currentPage - 2);
  const end = Math.min(totalPages, currentPage + 2);
  for (let page = start; page <= end; page += 1) {
    $pagination.append(pageItem(page, page, false, page === currentPage));
  }
  $pagination.append(pageItem("Next", currentPage + 1, currentPage >= totalPages));
}

function updateFeedMeta() {
  if (totalPosts === 0) {
    $("#feedMeta").text(currentSearch ? `No posts found for “${currentSearch}”` : "No posts yet");
    return;
  }
  const searchText = currentSearch ? ` matching “${currentSearch}”` : "";
  $("#feedMeta").text(`${totalPosts} post${totalPosts === 1 ? "" : "s"}${searchText} • page ${currentPage} of ${totalPages}`);
}

async function loadPosts(page = currentPage) {
  currentPage = page;
  $("#loading").removeClass("d-none");
  setMessage("#formMessage", "", "muted");
  try {
    const params = new URLSearchParams({ page: currentPage, limit: PAGE_SIZE });
    if (currentSearch) params.set("q", currentSearch);
    const payload = await apiRequest(`/posts?${params.toString()}`);
    totalPages = payload.total_pages || 1;
    totalPosts = payload.total || 0;
    currentPage = payload.page || currentPage;
    renderPosts(payload.posts || []);
    renderPagination();
    updateFeedMeta();
  } catch (error) {
    $("#postsList").empty();
    $("#emptyState").removeClass("d-none");
    $("#emptyText").text(error.message);
    $("#feedMeta").text("Unable to load posts");
  } finally {
    $("#loading").addClass("d-none");
  }
}

function resetPostForm() {
  $("#postForm")[0].reset();
  $("#postImagePreview").addClass("d-none");
  updateCounts();
}

async function submitPost(event) {
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
    resetPostForm();
    setMessage("#formMessage", "Post saved.", "success");
    currentPage = 1;
    await loadPosts(1);
  } catch (error) {
    setMessage("#formMessage", error.message, "danger");
  } finally {
    $("#submitBtn").prop("disabled", false);
  }
}

function openEditModal(id) {
  const post = postsById[id];
  if (!post) return;
  editRemoveImage = false;
  $("#editPostId").val(post._id);
  $("#editContent").val(post.content);
  $("#editTags").val(tagsToInput(post.tags));
  $("#editImage").val("");
  $("#editImagePreview").addClass("d-none");
  setMessage("#editMessage", "", "muted");
  if (post.image && post.image.data_uri) {
    $("#editExistingImageImg").attr("src", post.image.data_uri);
    $("#editExistingImage").removeClass("d-none");
  } else {
    $("#editExistingImage").addClass("d-none");
  }
  updateCounts();
  editModal.show();
}

async function saveEdit(event) {
  event.preventDefault();
  const id = $("#editPostId").val();
  setMessage("#editMessage", "Saving...", "muted");
  $("#saveEditBtn").prop("disabled", true);
  try {
    const image = await buildImagePayload($("#editImage")[0]);
    await apiRequest(`/posts/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({
        content: $("#editContent").val(),
        tags: parseTags($("#editTags").val()),
        image,
        remove_image: editRemoveImage
      })
    });
    editModal.hide();
    await loadPosts(currentPage);
  } catch (error) {
    setMessage("#editMessage", error.message, "danger");
  } finally {
    $("#saveEditBtn").prop("disabled", false);
  }
}

async function deletePost(id) {
  if (!confirm("Delete this post permanently?")) return;
  try {
    await apiRequest(`/posts/${encodeURIComponent(id)}`, { method: "DELETE" });
    const nextPage = currentPage > 1 && totalPosts - 1 <= (currentPage - 1) * PAGE_SIZE ? currentPage - 1 : currentPage;
    await loadPosts(nextPage);
  } catch (error) {
    alert(error.message);
  }
}

async function exportPosts() {
  $("#exportBtn").prop("disabled", true).text("Exporting...");
  try {
    const payload = await apiRequest("/export");
    const byteChars = atob(payload.data_base64);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i += 1) bytes[i] = byteChars.charCodeAt(i);
    const blob = new Blob([bytes], { type: payload.content_type || "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = payload.filename || "personal-feed-export.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    alert(error.message);
  } finally {
    $("#exportBtn").prop("disabled", false).text("Export JSON + TXT");
  }
}

$(function () {
  editModal = new bootstrap.Modal(document.getElementById("editModal"));
  updateCounts();
  loadPosts(1);

  $("#postContent, #editContent").on("input", updateCounts);
  $("#postForm").on("submit", submitPost);
  $("#editForm").on("submit", saveEdit);
  $("#refreshBtn").on("click", () => loadPosts(currentPage));
  $("#exportBtn").on("click", exportPosts);

  $("#searchBox").on("input", function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      currentSearch = $(this).val().trim();
      loadPosts(1);
    }, 250);
  });

  $("#postImage").on("change", () => setImagePreview("#postImage", "#postImagePreview", "#postImagePreviewImg", "#postImageInfo", "#formMessage"));
  $("#editImage").on("change", () => {
    editRemoveImage = false;
    setImagePreview("#editImage", "#editImagePreview", "#editImagePreviewImg", "#editImageInfo", "#editMessage");
  });

  $("#clearPostImage").on("click", function () {
    $("#postImage").val("");
    $("#postImagePreview").addClass("d-none");
  });

  $("#clearEditImage").on("click", function () {
    $("#editImage").val("");
    $("#editImagePreview").addClass("d-none");
  });

  $("#removeExistingImage").on("click", function () {
    editRemoveImage = true;
    $("#editExistingImage").addClass("d-none");
    $("#editImage").val("");
    $("#editImagePreview").addClass("d-none");
  });

  $(document).on("click", ".edit-post", function () {
    openEditModal($(this).data("id"));
  });

  $(document).on("click", ".delete-post", function () {
    deletePost($(this).data("id"));
  });

  $(document).on("click", ".page-link", function () {
    const page = Number($(this).data("page"));
    if (page && page !== currentPage) loadPosts(page);
  });

  $(document).on("click", ".js-tag-search", function () {
    currentSearch = `#${$(this).data("tag")}`;
    $("#searchBox").val(currentSearch);
    loadPosts(1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
});
