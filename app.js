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

function renderPosts(posts) {
  const $list = $("#postsList");
  $list.empty();

  if (!posts.length) {
    $("#emptyState").removeClass("d-none");
    $("#emptyText").text(currentSearch ? `No posts contain “${currentSearch}”.` : "Create your first post using the textarea above.");
    return;
  }

  $("#emptyState").addClass("d-none");

  posts.forEach((post) => {
    const content = escapeHtml(post.content);
    const created = formatDate(post.created_at);
    const updated = post.updated_at && post.updated_at !== post.created_at ? ` · edited ${formatDate(post.updated_at)}` : "";
    const imageHtml = post.image && post.image.data_uri
      ? `<div class="post-image-wrap mt-3"><img class="post-image" src="${post.image.data_uri}" alt="${escapeHtml(post.image.filename || "Post image")}"></div>`
      : "";

    const item = `
      <article class="list-group-item post-item p-4" data-id="${escapeHtml(post._id)}">
        <div class="d-flex flex-wrap justify-content-between gap-3">
          <div class="min-width-0 flex-grow-1">
            <div class="post-content">${content}</div>
            ${imageHtml}
            <div class="post-date text-muted mt-3">${created}${updated}</div>
          </div>
          <div class="post-actions d-flex gap-2 align-self-start">
            <button class="btn btn-outline-primary btn-sm edit-post" type="button">Edit</button>
            <button class="btn btn-outline-danger btn-sm delete-post" type="button">Delete</button>
          </div>
        </div>
      </article>`;
    $list.append(item);
  });
}

function renderPagination() {
  const $pagination = $("#pagination");
  $pagination.empty();

  if (totalPages <= 1) return;

  const makeItem = (label, page, disabled = false, active = false) => {
    return `<li class="page-item ${disabled ? "disabled" : ""} ${active ? "active" : ""}">
      <button class="page-link" type="button" data-page="${page}" ${disabled ? "disabled" : ""}>${label}</button>
    </li>`;
  };

  $pagination.append(makeItem("Previous", currentPage - 1, currentPage <= 1));

  const start = Math.max(1, currentPage - 2);
  const end = Math.min(totalPages, currentPage + 2);
  for (let page = start; page <= end; page += 1) {
    $pagination.append(makeItem(page, page, false, page === currentPage));
  }

  $pagination.append(makeItem("Next", currentPage + 1, currentPage >= totalPages));
}

function updateFeedMeta() {
  if (currentSearch) {
    $("#feedMeta").text(`${totalPosts} matching post${totalPosts === 1 ? "" : "s"} for “${currentSearch}”`);
  } else {
    $("#feedMeta").text(`${totalPosts} post${totalPosts === 1 ? "" : "s"} saved`);
  }
}

async function loadPosts(page = 1) {
  currentPage = page;
  currentSearch = $("#searchBox").val().trim();
  $("#loading").removeClass("d-none");
  $("#postsList").empty();
  $("#emptyState").addClass("d-none");

  try {
    const params = new URLSearchParams({ page: String(currentPage), limit: String(PAGE_SIZE) });
    if (currentSearch) params.set("q", currentSearch);
    const payload = await apiRequest(`/posts?${params.toString()}`);
    totalPages = payload.total_pages || 1;
    totalPosts = payload.total || 0;
    currentPage = payload.page || currentPage;
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
  $("#postImage").val("");
  $("#postImagePreview").addClass("d-none");
  $("#postImagePreviewImg").attr("src", "");
  $("#postImageInfo").text("");
  updateCounts();
}

function postFromElement($item) {
  return {
    id: $item.data("id"),
    content: $item.find(".post-content").text(),
    imageSrc: $item.find(".post-image").attr("src") || ""
  };
}

function openEditModal($item) {
  const post = postFromElement($item);
  $("#editPostId").val(post.id);
  $("#editContent").val(post.content);
  $("#editImage").val("");
  $("#editRemoveImage").val("false");
  $("#editImagePreview").addClass("d-none");
  setMessage("#editMessage", "", "muted");

  if (post.imageSrc) {
    $("#currentImage").attr("src", post.imageSrc);
    $("#currentImageWrap").removeClass("d-none");
  } else {
    $("#currentImage").attr("src", "");
    $("#currentImageWrap").addClass("d-none");
  }
  updateCounts();
  editModal.show();
}

function downloadBase64File(base64, filename, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

$(document).ready(() => {
  editModal = new bootstrap.Modal(document.getElementById("editModal"));
  updateCounts();
  loadPosts(1);

  $("#postContent, #editContent").on("input", updateCounts);

  $("#searchBox").on("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadPosts(1), 250);
  });

  $("#postImage").on("change", () => {
    setImagePreview("#postImage", "#postImagePreview", "#postImagePreviewImg", "#postImageInfo", "#formMessage");
  });

  $("#editImage").on("change", () => {
    setImagePreview("#editImage", "#editImagePreview", "#editImagePreviewImg", "#editImageInfo", "#editMessage");
    if ($("#editImage")[0].files.length) {
      $("#editRemoveImage").val("false");
    }
  });

  $("#clearPostImage").on("click", () => {
    $("#postImage").val("");
    $("#postImagePreview").addClass("d-none");
    setMessage("#formMessage", "", "muted");
  });

  $("#clearEditImage").on("click", () => {
    $("#editImage").val("");
    $("#editImagePreview").addClass("d-none");
  });

  $("#removeCurrentImage").on("click", () => {
    $("#editRemoveImage").val("true");
    $("#currentImageWrap").addClass("d-none");
    $("#editImage").val("");
    $("#editImagePreview").addClass("d-none");
    setMessage("#editMessage", "Current image will be removed when you save.", "muted");
  });

  $("#postForm").on("submit", async (event) => {
    event.preventDefault();
    setMessage("#formMessage", "", "muted");
    $("#submitBtn").prop("disabled", true).text("Submitting...");

    try {
      const image = await buildImagePayload($("#postImage")[0]);
      await apiRequest("/posts", {
        method: "POST",
        body: JSON.stringify({ content: $("#postContent").val(), image })
      });
      resetComposer();
      setMessage("#formMessage", "Post saved.", "success");
      loadPosts(1);
    } catch (error) {
      setMessage("#formMessage", error.message, "danger");
    } finally {
      $("#submitBtn").prop("disabled", false).text("Submit Post");
    }
  });

  $("#postsList").on("click", ".edit-post", function () {
    openEditModal($(this).closest(".post-item"));
  });

  $("#postsList").on("click", ".delete-post", async function () {
    const $item = $(this).closest(".post-item");
    const id = $item.data("id");
    if (!confirm("Delete this post?")) return;

    try {
      await apiRequest(`/posts/${id}`, { method: "DELETE" });
      loadPosts(currentPage);
    } catch (error) {
      setMessage("#formMessage", error.message, "danger");
    }
  });

  $("#editForm").on("submit", async (event) => {
    event.preventDefault();
    setMessage("#editMessage", "", "muted");
    $("#saveEditBtn").prop("disabled", true).text("Saving...");

    try {
      const id = $("#editPostId").val();
      const image = await buildImagePayload($("#editImage")[0]);
      const payload = {
        content: $("#editContent").val(),
        remove_image: $("#editRemoveImage").val() === "true"
      };
      if (image) payload.image = image;

      await apiRequest(`/posts/${id}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });
      editModal.hide();
      loadPosts(currentPage);
    } catch (error) {
      setMessage("#editMessage", error.message, "danger");
    } finally {
      $("#saveEditBtn").prop("disabled", false).text("Save changes");
    }
  });

  $("#pagination").on("click", ".page-link", function () {
    const page = Number($(this).data("page"));
    if (page && page !== currentPage && page >= 1 && page <= totalPages) loadPosts(page);
  });

  $("#refreshBtn").on("click", () => loadPosts(currentPage));

  $("#exportBtn").on("click", async () => {
    $("#exportBtn").prop("disabled", true).text("Exporting...");
    try {
      const payload = await apiRequest("/export");
      downloadBase64File(payload.zip_base64, payload.filename || "personal-feed-export.zip", "application/zip");
    } catch (error) {
      setMessage("#formMessage", error.message, "danger");
    } finally {
      $("#exportBtn").prop("disabled", false).text("Export ZIP");
    }
  });
});
