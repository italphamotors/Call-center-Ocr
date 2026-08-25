// === Gestion de l'upload (drag&drop, fichier, photo mobile) ===

const ALLOWED_EXT = ['jpg', 'jpeg', 'png', 'pdf'];
const MAX_SIZE = 10 * 1024 * 1024; // 10 Mo

let selectedFile = null;

const dropzone   = document.getElementById('dropzone');
const fileInput  = document.getElementById('fileInput');
const cameraInput = document.getElementById('cameraInput');
const btnChooseFile = document.getElementById('btnChooseFile');
const btnTakePhoto  = document.getElementById('btnTakePhoto');
const previewArea   = document.getElementById('previewArea');
const fileNameSpan  = document.getElementById('fileName');
const thumbnailContainer = document.getElementById('thumbnailContainer');
const uploadError   = document.getElementById('uploadError');
const btnAnalyze    = document.getElementById('btnAnalyze');

btnChooseFile.addEventListener('click', () => fileInput.click());
btnTakePhoto.addEventListener('click', () => cameraInput.click());
dropzone.addEventListener('click', (e) => {
  if (e.target === dropzone || e.target.tagName === 'P') fileInput.click();
});

fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));
cameraInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

['dragenter', 'dragover'].forEach(evt =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); })
);
['dragleave', 'drop'].forEach(evt =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); })
);
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

function handleFile(file) {
  uploadError.classList.add('hidden');
  if (!file) return;

  const ext = file.name.split('.').pop().toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) {
    showUploadError("Format non autorisé. Utilisez JPG, PNG ou PDF.");
    return;
  }
  if (file.size > MAX_SIZE) {
    showUploadError("Fichier trop volumineux (10 Mo max).");
    return;
  }

  selectedFile = file;
  fileNameSpan.textContent = file.name;
  previewArea.classList.remove('hidden');
  btnAnalyze.classList.remove('hidden');

  thumbnailContainer.innerHTML = '';
  if (file.type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = document.createElement('img');
      img.src = e.target.result;
      thumbnailContainer.appendChild(img);
    };
    reader.readAsDataURL(file);
  } else {
    thumbnailContainer.innerHTML = '<span style="font-size:24px;">📄</span> Document PDF';
  }
}

function showUploadError(msg) {
  uploadError.textContent = msg;
  uploadError.classList.remove('hidden');
  btnAnalyze.classList.add('hidden');
  previewArea.classList.add('hidden');
  selectedFile = null;
}
