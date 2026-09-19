const API_BASE = '/api/apps/personal-feed';
const PAGE_SIZE = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

let currentPage = 1;
let totalPages = 1;
let currentSearch = '';
let postsById = {};
let editModal;
let editRemoveImage = false;
let searchTimer;

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#039;');
}

function formatDate(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatFileSize(bytes) {
  if (!bytes) return '0 bytes';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setMessage(selector, message, type = 'danger') {
  const el = $(selector);
  el.removeClass('text-danger text-success text-muted');
  if (!message) return el.text('');
  el.addClass(type === 'success' ? 'text-success' : type === 'muted' ? 'text-muted' : 'text-danger').text(message);
}

function parseTags(value) {
  return String(value || '').split(/[\s,]+/).map(t => t.trim().replace(/^#+/, '').toLowerCase()).filter(Boolean).filter((t, i, a) => a.indexOf(t) === i);
}

function tagsToInput(tags) {
  return Array.isArray(tags) ? tags.join(', ') : '';
}

function updateCounts() {
  $('#charCount').text(`${$('#postContent').val().length} / 5000`);
  $('#editCharCount').text(`${$('#editContent').val().length} / 5000`);
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  let payload;
  try { payload = await response.json(); } catch { payload = { ok: false, error: 'Invalid server response' }; }
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function validateImageFile(file) {
  if (!file) return;
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) throw new Error('Please choose a JPEG, PNG, GIF, or WebP image.');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Image must be 5 MB or smaller.');
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Unable to read image file'));
    reader.readAsDataURL(file);
  });
}

async function buildImagePayload(inputEl) {
  const file = inputEl && inputEl.files && inputEl.files[0];
  if (!file) return null;
  validateImageFile(file);
  const dataUrl = await readFileAsDataURL(file);
  return { filename: file.name, mime_type: file.type, data: String(dataUrl).split(',')[1] };
}

function previewImage(inputSelector, wrapSelector, imgSelector, infoSelector, messageSelector) {
  const input = $(inputSelector)[0];
  const file = input?.files?.[0];
  if (!file) {
    $(wrapSelector).addClass('d-none');
    $(imgSelector).attr('src', '');
    $(infoSelector).text('');
    return;
  }
  try {
    validateImageFile(file);
    $(imgSelector).attr('src', URL.createObjectURL(file));
    $(infoSelector).text(`${file.name} • ${formatFileSize(file.size)}`);
    $(wrapSelector).removeClass('d-none');
    if (messageSelector) setMessage(messageSelector, '', 'muted');
  } catch (err) {
    input.value = '';
    $(wrapSelector).addClass('d-none');
    if (messageSelector) setMessage(messageSelector, err.message);
  }
}

function renderTags(tags) {
  if (!Array.isArray(tags) || !tags.length) return '';
  return `<div class='tag-list mt-2'>${tags.map(tag => `<button type='button' class='tag-chip' data-tag='${escapeHtml(tag)}'>#${escapeHtml(tag)}</button>`).join('')}</div>`;
}

function renderPost(post) {
  const image = post.image && post.image.data_uri ? `<div class='post-image-wrap mt-3'><img class='post-image' src='${post.image.data_uri}' alt='Image attached to post'></div>` : '';
  return `<article class='list-group-item post-item p-3' data-id='${escapeHtml(post._id)}'>
    <div class='d-flex flex-wrap justify-content-between gap-2'>
      <div class='min-width-0 flex-grow-1'>
        <div class='post-content'>${escapeHtml(post.content)}</div>
        ${image}
        ${renderTags(post.tags)}
        <div class='post-date text-muted mt-2'>Created ${formatDate(post.created_at)}${post.updated_at && post.updated_at !== post.created_at ? ` • Updated ${formatDate(post.updated_at)}` : ''}</div>
      </div>
      <div class='post-actions d-flex gap-2 align-self-start'>
        <button type='button' class='btn btn-outline-primary btn-sm edit-post'>Edit</button>
        <button type='button' class='btn btn-outline-danger btn-sm delete-post'>Delete</button>
      </div>
    </div>
  </article>`;
}

function renderPagination() {
  const el = $('#pagination').empty();
  if (totalPages <= 1) return;
  const item = (page, label, disabled, active) => `<li class='page-item ${disabled ? 'disabled' : ''} ${active ? 'active' : ''}'><button class='page-link' data-page='${page}' type='button'>${label}</button></li>`;
  el.append(item(currentPage - 1, 'Prev', currentPage <= 1, false));
  const start = Math.max(1, currentPage - 2);
  const end = Math.min(totalPages, currentPage + 2);
  for (let p = start; p <= end; p++) el.append(item(p, p, false, p === currentPage));
  el.append(item(currentPage + 1, 'Next', currentPage >= totalPages, false));
}

async function loadPosts(page = 1) {
  currentPage = page;
  $('#loading').removeClass('d-none');
  $('#postsList').empty();
  $('#emptyState').addClass('d-none');
  try {
    const q = encodeURIComponent(currentSearch);
    const payload = await apiRequest(`/posts?page=${currentPage}&limit=${PAGE_SIZE}&q=${q}`);
    currentPage = payload.page;
    totalPages = payload.total_pages;
    postsById = {};
    payload.posts.forEach(post => { postsById[post._id] = post; });
    $('#postsList').html(payload.posts.map(renderPost).join(''));
    $('#feedMeta').text(payload.total ? `${payload.total} post${payload.total === 1 ? '' : 's'}${currentSearch ? ` matching “${currentSearch}”` : ''}` : 'No posts yet');
    if (!payload.posts.length) {
      $('#emptyText').text(currentSearch ? 'No posts match your search.' : 'Create your first post using the textarea above.');
      $('#emptyState').removeClass('d-none');
    }
    renderPagination();
  } catch (err) {
    $('#feedMeta').text('Unable to load posts');
    $('#emptyText').text(err.message);
    $('#emptyState').removeClass('d-none');
  } finally {
    $('#loading').addClass('d-none');
  }
}

function resetComposer() {
  $('#postForm')[0].reset();
  $('#postImagePreview').addClass('d-none');
  $('#postImagePreviewImg').attr('src', '');
  $('#postImageInfo').text('');
  updateCounts();
}

async function submitPost(event) {
  event.preventDefault();
  setMessage('#formMessage', '', 'muted');
  $('#submitBtn').prop('disabled', true).text('Saving...');
  try {
    const image = await buildImagePayload($('#postImage')[0]);
    await apiRequest('/posts', { method: 'POST', body: JSON.stringify({ content: $('#postContent').val(), tags: parseTags($('#postTags').val()), image }) });
    resetComposer();
    setMessage('#formMessage', 'Post saved.', 'success');
    currentSearch = '';
    $('#searchBox').val('');
    await loadPosts(1);
  } catch (err) {
    setMessage('#formMessage', err.message);
  } finally {
    $('#submitBtn').prop('disabled', false).text('Submit Post');
  }
}

function openEdit(id) {
  const post = postsById[id];
  if (!post) return;
  editRemoveImage = false;
  $('#editId').val(post._id);
  $('#editContent').val(post.content);
  $('#editTags').val(tagsToInput(post.tags));
  $('#editImage').val('');
  $('#editImagePreview').addClass('d-none');
  $('#editMessage').text('');
  if (post.image && post.image.data_uri) {
    $('#currentImage').attr('src', post.image.data_uri);
    $('#currentImageWrap').removeClass('d-none');
    $('#removeCurrentImage').text('Remove current image').prop('disabled', false);
  } else {
    $('#currentImageWrap').addClass('d-none');
  }
  updateCounts();
  editModal.show();
}

async function saveEdit(event) {
  event.preventDefault();
  const id = $('#editId').val();
  $('#saveEditBtn').prop('disabled', true).text('Saving...');
  setMessage('#editMessage', '', 'muted');
  try {
    const image = await buildImagePayload($('#editImage')[0]);
    await apiRequest(`/posts/${id}`, { method: 'PUT', body: JSON.stringify({ content: $('#editContent').val(), tags: parseTags($('#editTags').val()), image, remove_image: editRemoveImage }) });
    editModal.hide();
    await loadPosts(currentPage);
  } catch (err) {
    setMessage('#editMessage', err.message);
  } finally {
    $('#saveEditBtn').prop('disabled', false).text('Save changes');
  }
}

async function deletePost(id) {
  if (!confirm('Delete this post? This cannot be undone.')) return;
  try {
    await apiRequest(`/posts/${id}`, { method: 'DELETE' });
    await loadPosts(currentPage);
  } catch (err) {
    alert(err.message);
  }
}

function downloadBase64File(filename, mimeType, base64Data) {
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'personal-feed-export.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportZip() {
  $('#exportBtn').prop('disabled', true).text('Exporting...');
  try {
    const payload = await apiRequest('/export');
    downloadBase64File(payload.filename, payload.mime_type, payload.data);
  } catch (err) {
    alert(err.message);
  } finally {
    $('#exportBtn').prop('disabled', false).text('Export ZIP');
  }
}

$(function () {
  editModal = new bootstrap.Modal(document.getElementById('editModal'));
  $('#postContent, #editContent').on('input', updateCounts);
  $('#postForm').on('submit', submitPost);
  $('#editForm').on('submit', saveEdit);
  $('#postImage').on('change', () => previewImage('#postImage', '#postImagePreview', '#postImagePreviewImg', '#postImageInfo', '#formMessage'));
  $('#editImage').on('change', () => { editRemoveImage = false; previewImage('#editImage', '#editImagePreview', '#editImagePreviewImg', '#editImageInfo', '#editMessage'); });
  $('#clearPostImage').on('click', () => { $('#postImage').val(''); previewImage('#postImage', '#postImagePreview', '#postImagePreviewImg', '#postImageInfo'); });
  $('#clearEditImage').on('click', () => { $('#editImage').val(''); previewImage('#editImage', '#editImagePreview', '#editImagePreviewImg', '#editImageInfo'); });
  $('#removeCurrentImage').on('click', function () { editRemoveImage = true; $('#currentImageWrap').addClass('d-none'); $('#editImage').val(''); $('#editImagePreview').addClass('d-none'); });
  $('#refreshBtn').on('click', () => loadPosts(currentPage));
  $('#exportBtn').on('click', exportZip);
  $('#searchBox').on('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(() => { currentSearch = $(this).val().trim(); loadPosts(1); }, 250); });
  $('#postsList').on('click', '.edit-post', function () { openEdit($(this).closest('.post-item').data('id')); });
  $('#postsList').on('click', '.delete-post', function () { deletePost($(this).closest('.post-item').data('id')); });
  $('#postsList').on('click', '.tag-chip', function () { currentSearch = `#${$(this).data('tag')}`; $('#searchBox').val(currentSearch); loadPosts(1); });
  $('#pagination').on('click', '.page-link', function () { const page = Number($(this).data('page')); if (page >= 1 && page <= totalPages && page !== currentPage) loadPosts(page); });
  updateCounts();
  loadPosts(1);
});
