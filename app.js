const API_BASE = "/api/apps/personal-feed";
const PAGE_SIZE = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

let currentPage = 1;
let totalPages = 1;
let editModal;

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
    return;
  }

  $("#emptyState").addClass("d-none");

  posts.forEach((post) => {
    const content = escapeHtml(post.content);
    const created = formatDate(post.created_at);
    const updated = post.updated_at && post.updated_at !== post.created_at ? `<span class="ms-2 text-muted">Edited ${escapeHtml(formatDate(post.updated_at))}</span>` : "";
    const imageHtml = post.image && post.image.data_uri ? `
      <div class="post-image-wrap mt-3">
        <img class="post-image" src="${escapeHtml(post.image.data_uri)}" alt="Attached image for post">
        <div class="small text-muted mt-1">${escapeHtml(post.image.filename || "Attached image")}</div>
      </div>
    ` : "";

    const item = $(`
      <article class="list-group-item post-item p-4" data-id="${escapeHtml(post._id)}">
        <div class="d-flex flex-column flex-sm-row justify-content-between gap-2">
          <div class="flex-grow-1 min-width-0">
            <div class="post-date text-muted mb-2">
              <strong>${escapeHtml(created)}</strong>${updated}
            </div>
            <div class="post-content">${content}</div>
            ${imageHtml}
          </div>
          <div class="post-actions d-flex gap-2 align-self-start">
            <button class="btn btn-outline-primary btn-sm edit-post" type="button">Edit</button>
            <button class="btn btn-outline-danger btn-sm delete-post" type="button">Delete</button>
          </div>
        </div>
      </article>
    `);

    item.data("post", post);
    $list.append(item);
  });
}

function renderPagination(page, pages) {
  const $pagination = $("#pagination");
  $pagination.empty();

  if (pages <= 1) return;

  const addItem = (label, targetPage, disabled = false, active = false) => {
    const item = $(`
      <li class="page-item ${disabled ? "disabled" : ""} ${active ? "active" : ""}">
        <a class="page-link" role="button">${label}</a>
      </li>
    `);
    if (!disabled && !active) {
      item.on("click", () => loadPosts(targetPage));
    }
    $pagination.append(item);
  };

  addItem("Previous", page - 1, page <= 1);

  const start = Math.max(1, page - 2);
  const end = Math.min(pages, page + 2);

  if (start > 1) {
    addItem("1", 1, false, page === 1);
    if (start > 2) addItem("…", page, true);
  }

  for (let p = start; p <= end; p += 1) {
    addItem(String(p), p, false, p === page);
  }

  if (end < pages) {
    if (end < pages - 1) addItem("…", page, true);
    addItem(String(pages), pages, false, page === pages);
  }

  addItem("Next", page + 1, page >= pages);
}

async function loadPosts(page = currentPage) {
  $("#loading").removeClass("d-none");
  $("#emptyState").addClass("d-none");
  setMessage("#formMessage", "", "muted");

  try {
    const payload = await apiRequest(`/posts?page=${page}&limit=${PAGE_SIZE}`);
    currentPage = payload.page;
    totalPages = payload.total_pages;
    renderPosts(payload.posts || []);
    renderPagination(currentPage, totalPages);
    const total = payload.total || 0;
    $("#feedMeta").text(total === 1 ? "1 post" : `${total} posts`);
  } catch (error) {
    $("#postsList").empty();
    $("#pagination").empty();
    $("#feedMeta").text("Unable to load posts");
    setMessage("#formMessage", error.message, "danger");
  } finally {
    $("#loading").addClass("d-none");
  }
}

function clearPostImage() {
  $("#postImage").val("");
  $("#postImagePreview").addClass("d-none");
  $("#postImagePreviewImg").attr("src", "");
  $("#postImageInfo").text("");
}

function clearEditImage() {
  $("#editImage").val("");
  $("#editImagePreview").addClass("d-none");
  $("#editImagePreviewImg").attr("src", "");
  $("#editImageInfo").text("");
}

function resetComposer() {
  $("#postForm")[0].reset();
  clearPostImage();
  updateCounts();
}

function openEditModal(post) {
  $("#editPostId").val(post._id);
  $("#editContent").val(post.content || "");
  $("#editRemoveImage").prop("checked", false);
  setMessage("#editMessage", "", "muted");
  clearEditImage();

  if (post.image && post.image.data_uri) {
    $("#existingImage").attr("src", post.image.data_uri);
    $("#existingImageInfo").text(post.image.filename || "Attached image");
    $("#existingImageWrap").removeClass("d-none");
  } else {
    $("#existingImage").attr("src", "");
    $("#existingImageInfo").text("");
    $("#existingImageWrap").addClass("d-none");
  }

  updateCounts();
  editModal.show();
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const chunks = [];
  for (let offset = 0; offset < binary.length; offset += 1024) {
    const slice = binary.slice(offset, offset + 1024);
    const bytes = new Uint8Array(slice.length);
    for (let i = 0; i < slice.length; i += 1) {
      bytes[i] = slice.charCodeAt(i);
    }
    chunks.push(bytes);
  }
  return new Blob(chunks, { type: mimeType || "application/octet-stream" });
}

async function exportFeed() {
  const $button = $("#exportBtn");
  $button.prop("disabled", true).text("Exporting...");
  setMessage("#formMessage", "Preparing ZIP export...", "muted");

  try {
    const payload = await apiRequest("/export");
    const blob = base64ToBlob(payload.data, payload.mime_type || "application/zip");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = payload.filename || "personal-feed.zip";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setMessage("#formMessage", `Exported ${payload.count || 0} posts.`, "success");
  } catch (error) {
    setMessage("#formMessage", error.message, "danger");
  } finally {
    $button.prop("disabled", false).text("Export ZIP");
  }
}

$(function () {
  editModal = new bootstrap.Modal(document.getElementById("editModal"));

  $("#postContent, #editContent").on("input", updateCounts);
  $("#postImage").on("change", () => setImagePreview("#postImage", "#postImagePreview", "#postImagePreviewImg", "#postImageInfo", "#formMessage"));
  $("#editImage").on("change", () => setImagePreview("#editImage", "#editImagePreview", "#editImagePreviewImg", "#editImageInfo", "#editMessage"));
  $("#clearPostImage").on("click", clearPostImage);
  $("#clearEditImage").on("click", clearEditImage);
  $("#refreshBtn").on("click", () => loadPosts(currentPage));
  $("#exportBtn").on("click", exportFeed);

  $("#postForm").on("submit", async function (event) {
    event.preventDefault();
    const content = $("#postContent").val().trim();
    if (!content) {
      setMessage("#formMessage", "Please write some text for your post.", "danger");
      return;
    }

    const $button = $("#submitBtn");
    $button.prop("disabled", true).text("Submitting...");
    setMessage("#formMessage", "", "muted");

    try {
      const image = await buildImagePayload($("#postImage")[0]);
      const body = { content };
      if (image) body.image = image;
      await apiRequest("/posts", {
        method: "POST",
        body: JSON.stringify(body)
      });
      resetComposer();
      setMessage("#formMessage", "Post saved.", "success");
      await loadPosts(1);
    } catch (error) {
      setMessage("#formMessage", error.message, "danger");
    } finally {
      $button.prop("disabled", false).text("Submit Post");
    }
  });

  $("#postsList").on("click", ".edit-post", function () {
    const post = $(this).closest(".post-item").data("post");
    openEditModal(post);
  });

  $("#postsList").on("click", ".delete-post", async function () {
    const $item = $(this).closest(".post-item");
    const post = $item.data("post");
    if (!confirm("Delete this post?")) return;

    try {
      await apiRequest(`/posts/${post._id}`, { method: "DELETE" });
      setMessage("#formMessage", "Post deleted.", "success");
      await loadPosts(currentPage);
    } catch (error) {
      setMessage("#formMessage", error.message, "danger");
    }
  });

  $("#editForm").on("submit", async function (event) {
    event.preventDefault();
    const id = $("#editPostId").val();
    const content = $("#editContent").val().trim();
    if (!content) {
      setMessage("#editMessage", "Content cannot be empty.", "danger");
      return;
    }

    const $button = $("#saveEditBtn");
    $button.prop("disabled", true).text("Saving...");

    try {
      const image = await buildImagePayload($("#editImage")[0]);
      const body = {
        content,
        remove_image: $("#editRemoveImage").is(":checked")
      };
      if (image) {
        body.image = image;
        body.remove_image = false;
      }
      await apiRequest(`/posts/${id}`, {
        method: "PUT",
        body: JSON.stringify(body)
      });
      editModal.hide();
      setMessage("#formMessage", "Post updated.", "success");
      await loadPosts(currentPage);
    } catch (error) {
      setMessage("#editMessage", error.message, "danger");
    } finally {
      $button.prop("disabled", false).text("Save Changes");
    }
  });

  updateCounts();
  loadPosts(1);
});
