// Camera frames stay in the browser. Only a captured photo is offered to the
// existing editor; recognition still runs exclusively on the server.
export function setupCamera({onPhoto, onFallback}) {
  const $ = id => document.getElementById(id);
  const dialog = $('cameraDialog'), video = $('cameraPreview');
  const capture = $('cameraCapture'), devices = $('cameraDevice');
  let stream = null, generation = 0, opening = false, capturing = false;

  function message(text, error = false) {
    $('cameraStatus').textContent = text;
    $('cameraStatus').classList.toggle('error', error);
  }
  function ready() {
    return Boolean(stream?.getVideoTracks().some(track => track.readyState === 'live') &&
      video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0);
  }
  function controls() {
    capture.disabled = opening || capturing || !ready();
    devices.disabled = opening || capturing;
    $('cameraRetry').hidden = opening || capturing || ready();
    $('cameraFallback').disabled = capturing;
  }
  function stopStream() {
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    video.pause();
    video.srcObject = null;
  }
  function release() {
    generation++;
    stopStream();
    opening = capturing = false;
    controls();
  }
  function close() {
    release();
    if (dialog.open) dialog.close();
  }

  async function listDevices(request) {
    if (!navigator.mediaDevices.enumerateDevices) return;
    try {
      const cameras = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
      if (request !== generation || !dialog.open) return;
      const active = stream?.getVideoTracks()[0]?.getSettings().deviceId;
      devices.replaceChildren();
      cameras.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `摄像头 ${index + 1}`;
        devices.append(option);
      });
      if (cameras.some(device => device.deviceId === active)) devices.value = active;
      $('cameraDeviceLabel').hidden = cameras.length < 2;
    } catch {
      // Device enumeration is optional: a working preview must remain usable.
      if (request === generation) $('cameraDeviceLabel').hidden = true;
    }
  }

  async function start(deviceId) {
    if (!dialog.open) return;
    const request = ++generation;
    stopStream();
    opening = true; capturing = false;
    $('cameraDeviceLabel').hidden = true;
    message('正在打开摄像头，请在浏览器提示中允许访问。');
    controls();
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      opening = false;
      message(!window.isSecureContext ? '摄像头预览需要HTTPS，请使用网站的https地址打开。' :
        '当前浏览器不支持摄像头预览。可用下方“系统拍照 / 选图”，或在其他浏览器打开。', true);
      controls(); return;
    }
    try {
      const constraints = {width:{ideal:2560}, height:{ideal:1920},
        ...(deviceId ? {deviceId:{exact:deviceId}} : {facingMode:{ideal:'environment'}})};
      const acquired = await navigator.mediaDevices.getUserMedia({video:constraints, audio:false});
      // The user may close the dialog before answering the permission prompt.
      if (request !== generation || !dialog.open || document.hidden) {
        acquired.getTracks().forEach(track => track.stop());
        if (request === generation) close();
        return;
      }
      stream = acquired;
      video.srcObject = acquired;
      acquired.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
        if (request !== generation || !dialog.open) return;
        stopStream(); opening = false;
        message('摄像头已断开，请重新连接后点击“重新打开”。', true); controls();
      }, {once:true}));
      await video.play();
      if (request !== generation || !dialog.open) return;
      opening = false;
      message('预览清晰后，点击“拍摄并使用”。');
      controls();
      await listDevices(request);
    } catch (error) {
      if (request !== generation || !dialog.open) return;
      stopStream(); opening = false;
      const descriptions = {
        NotAllowedError:'摄像头权限被拒绝。请在浏览器的网站权限中允许摄像头，再点击“重新打开”。',
        PermissionDeniedError:'摄像头权限被拒绝。请允许浏览器使用摄像头后重试。',
        NotFoundError:'没有找到摄像头。请连接摄像头，或使用“系统拍照 / 选图”。',
        DevicesNotFoundError:'没有找到摄像头，请检查设备连接。',
        NotReadableError:'无法读取摄像头。请检查摄像头是否被其他软件占用，再重试。',
        TrackStartError:'无法启动摄像头，请检查设备是否被其他软件占用。',
        OverconstrainedError:'当前摄像头无法使用所选设置，请选择其他摄像头或重新打开。',
        SecurityError:'浏览器限制了摄像头访问，请检查网站权限或换浏览器打开。',
      };
      message(descriptions[error.name] || '摄像头未能启动。请检查网站权限和设备连接，或使用“系统拍照 / 选图”。', true);
      controls();
    }
  }

  function open() {
    if (dialog.open) return;
    devices.replaceChildren();
    dialog.showModal();
    void start();
  }
  $('cameraClose').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => { if (!dialog.open) release(); });
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom)) close();
  });
  $('cameraRetry').addEventListener('click', () => { void start(); });
  devices.addEventListener('change', () => { void start(devices.value); });
  $('cameraFallback').addEventListener('click', () => { close(); onFallback(); });
  video.addEventListener('loadeddata', controls);
  capture.addEventListener('click', async () => {
    if (!ready() || opening || capturing) return;
    const request = generation;
    capturing = true; controls(); message('正在拍摄…');
    const frame = document.createElement('canvas');
    try {
      // Guard against camera resolutions above the editor's 24 MP limit.
      const scale = Math.min(1, Math.sqrt(24_000_000 / (video.videoWidth * video.videoHeight)));
      frame.width = Math.floor(video.videoWidth * scale);
      frame.height = Math.floor(video.videoHeight * scale);
      frame.getContext('2d').drawImage(video, 0, 0, frame.width, frame.height);
      const blob = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('拍摄处理超时，请重试或使用系统拍照。')), 15000);
        try {
          frame.toBlob(blob => { clearTimeout(timeout); resolve(blob); }, 'image/jpeg', .94);
        } catch (error) { clearTimeout(timeout); reject(error); }
      });
      if (request !== generation || !dialog.open) return;
      if (!blob) throw new Error('无法生成照片，请重新拍摄。');
      if (blob.size > 20 * 1024 * 1024) throw new Error('拍摄照片超过20 MB，请降低摄像头分辨率后重试。');
      const date = new Date();
      const stamp = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(),
        date.getMinutes(), date.getSeconds(), date.getMilliseconds()].map(value => String(value).padStart(2, '0')).join('-');
      const file = new File([blob], `rice-camera-${stamp}.jpg`, {type:'image/jpeg'});
      close();
      await onPhoto(file);
    } catch (error) {
      if (request !== generation || !dialog.open) return;
      capturing = false; message(error.message || '拍摄失败，请重试。', true); controls();
    } finally {
      frame.width = frame.height = 1;
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && stream) close(); });
  controls();
  return {open, close};
}
