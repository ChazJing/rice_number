"""Optional browser QA for view rotation and camera preview/lifecycle.

Requires Playwright, Chromium and FFmpeg. Synthetic frames and outputs are
written only under ignored work/. A fake camera validates the browser flow;
this test does not claim physical webcam or WeChat device coverage.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from test_detection import rice_scene
from PIL import Image
from playwright.sync_api import sync_playwright, expect

folder = Path(__file__).resolve().parent.parent / 'work' / 'camera-rotation-qa'
folder.mkdir(parents=True, exist_ok=True)
scene, _ = rice_scene()
scene.save(folder / 'rice.png')
subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-loop','1','-i',str(folder/'rice.png'),
                '-r','5','-t','1','-threads','1','-filter_threads','1','-pix_fmt','yuv420p',str(folder/'rice.y4m')],check=True)
base_url = os.getenv('RICE_TEST_URL','http://127.0.0.1:8000')

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.getenv('RICE_CHROMIUM','/usr/bin/chromium'),
        args=['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',
              '--use-file-for-fake-video-capture='+str(folder/'rice.y4m')])
    page = browser.new_page(viewport={'width':1440,'height':1050})
    errors = []
    page.on('pageerror',lambda error: errors.append(str(error)))
    page.goto(base_url,wait_until='networkidle')
    page.locator('#fileInput').set_input_files(str(folder/'rice.png'))
    page.locator('#detectButton').click()
    expect(page.locator('#count')).to_have_text('20')
    # Every orientation supports deleting a known seed, undoing and adding a
    # point whose exported coordinates must remain in the original image.
    seed_view = [(500,100),(700,500),(100,700),(100,100)]
    blank_view = [(580,20),(780,580),(20,780),(20,20)]
    for turn, seed, blank in zip([1,2,3,0],seed_view,blank_view):
        page.locator('#rotateButton').click()
        assert page.locator('#rotationLabel').inner_text() == f'{turn*90}°'
        assert page.locator('#count').inner_text() == '20'
        width,height = (600,800) if turn%2 else (800,600)
        box = page.locator('#photoCanvas').bounding_box()
        def click_source_view(position):
            page.mouse.click(box['x']+position[0]/width*box['width'],box['y']+position[1]/height*box['height'])
        click_source_view(seed)
        assert page.locator('#count').inner_text() == '19'
        page.locator('#undoButton').click()
        assert page.locator('#count').inner_text() == '20'
        click_source_view(blank)
        assert page.locator('#count').inner_text() == '21'
        with page.expect_download() as download:
            page.locator('#exportData').click()
        target=folder/f'rotation-{turn}.json'
        download.value.save_as(str(target)); data=json.loads(target.read_text())
        assert data['view_rotation_degrees']==turn*90
        assert abs(data['points'][-1]['x']-20)<.1 and abs(data['points'][-1]['y']-20)<.1
        page.locator('#undoButton').click()
        assert page.locator('#count').inner_text() == '20'
    page.locator('#rotateButton').click()
    with page.expect_download() as download:
        page.locator('#exportImage').click()
    download.value.save_as(str(folder/'rotated.jpg'))
    image=Image.open(folder/'rotated.jpg')
    assert image.size==(600,854)
    red,green,blue=image.getpixel((500,100))
    assert red>green+40 and red>blue+40
    # Select a source rectangle through its rotated view; all 12 detections
    # and the exported selection must still use the original coordinate space.
    page.locator('[data-mode=roi]').click()
    box=page.locator('#photoCanvas').bounding_box()
    page.mouse.click(box['x']+588/600*box['width'],box['y']+200/800*box['height'])
    page.mouse.click(box['x']+12/600*box['width'],box['y']+600/800*box['height'])
    page.locator('#detectButton').click()
    expect(page.locator('#count')).to_have_text('12')
    assert page.locator('#rotationLabel').inner_text()=='90°'
    page.screenshot(path=str(folder/'desktop-rotated.png'),full_page=True)
    # A desktop camera button must open live preview rather than a file picker.
    chooser=[]
    page.on('filechooser',lambda event:chooser.append(event))
    page.locator('#cameraButton').click()
    expect(page.locator('#cameraCapture')).to_be_enabled(timeout=15000)
    assert not chooser
    assert page.evaluate("document.getElementById('cameraPreview').videoWidth")>0
    page.evaluate("window.testTrack=document.getElementById('cameraPreview').srcObject.getVideoTracks()[0]")
    page.screenshot(path=str(folder/'desktop-camera.png'),full_page=True)
    page.locator('#cameraCapture').click()
    expect(page.locator('#cameraDialog')).not_to_be_visible(timeout=15000)
    expect(page.locator('#photoName')).to_contain_text('rice-camera-')
    assert page.evaluate('window.testTrack.readyState')=='ended'
    assert page.evaluate("document.getElementById('cameraPreview').srcObject === null")
    assert page.locator('#rotationLabel').inner_text()=='0°'
    page.locator('#detectButton').click()
    expect(page.locator('#count')).to_have_text('20')
    name=page.locator('#photoName').inner_text()
    for close in ['button','escape']:
        page.locator('#cameraButton').click()
        expect(page.locator('#cameraCapture')).to_be_enabled(timeout=15000)
        page.evaluate("window.testTrack=document.getElementById('cameraPreview').srcObject.getVideoTracks()[0]")
        if close=='button': page.locator('#cameraClose').click()
        else: page.keyboard.press('Escape')
        expect(page.locator('#cameraDialog')).not_to_be_visible(timeout=15000)
        assert page.evaluate('window.testTrack.readyState')=='ended'
        assert page.locator('#photoName').inner_text()==name
    # Exercise switching with two enumerated devices while the actual frames
    # still come from Chromium's single fake camera. Check exact constraints
    # and that switching releases the old stream.
    page.evaluate('''() => {
      const media=navigator.mediaDevices, original=media.getUserMedia.bind(media);
      window.originalCamera=original;
      media.enumerateDevices=async()=>[{kind:'videoinput',deviceId:'first',label:'Camera 1'},
                                      {kind:'videoinput',deviceId:'second',label:'Camera 2'}];
      media.getUserMedia=async constraints=>{window.lastConstraints=constraints;return original({video:true,audio:false});};
    }''')
    page.locator('#cameraButton').click()
    expect(page.locator('#cameraCapture')).to_be_enabled(timeout=15000)
    expect(page.locator('#cameraDeviceLabel')).to_be_visible()
    page.evaluate("window.testTrack=document.getElementById('cameraPreview').srcObject.getVideoTracks()[0]")
    page.locator('#cameraDevice').select_option('second')
    expect(page.locator('#cameraCapture')).to_be_enabled(timeout=15000)
    assert page.evaluate('window.testTrack.readyState')=='ended'
    assert page.evaluate('window.lastConstraints.video.deviceId.exact')=='second'
    page.locator('#cameraClose').click()
    # Permission denied gets an explicit explanation and an optional chooser.
    page.evaluate("() => { navigator.mediaDevices.getUserMedia=()=>Promise.reject(new DOMException('denied','NotAllowedError')); }")
    page.locator('#cameraButton').click()
    expect(page.locator('#cameraStatus')).to_contain_text('权限被拒绝')
    assert page.locator('#cameraCapture').is_disabled()
    assert page.locator('#cameraRetry').is_visible()
    with page.expect_file_chooser() as choice:
        page.locator('#cameraFallback').click()
    choice.value.set_files(str(folder/'rice.png'))
    expect(page.locator('#photoName')).to_have_text('rice.png')
    # Resolve a permission request after closing. Its arriving stream must stop.
    page.evaluate('''() => {
      navigator.mediaDevices.getUserMedia=async()=>{
        const stream=await window.originalCamera({video:true,audio:false});
        window.lateTrack=stream.getVideoTracks()[0];
        await new Promise(resolve=>{window.releaseLateCamera=resolve;});return stream;
      };
    }''')
    page.locator('#cameraButton').click()
    page.wait_for_function('window.releaseLateCamera !== undefined')
    page.locator('#cameraClose').click()
    page.evaluate('window.releaseLateCamera()')
    page.wait_for_function("window.lateTrack.readyState === 'ended'")
    assert not page.locator('#cameraDialog').is_visible()
    mobile=browser.new_page(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
    mobile.on('pageerror',lambda error:errors.append(str(error)))
    mobile.goto(base_url,wait_until='networkidle')
    mobile.locator('#cameraEmpty').click()
    expect(mobile.locator('#cameraCapture')).to_be_enabled(timeout=15000)
    assert mobile.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
    mobile.screenshot(path=str(folder/'mobile-camera.png'),full_page=True)
    mobile.locator('#cameraCapture').click()
    expect(mobile.locator('#photoName')).to_contain_text('rice-camera-',timeout=15000)
    mobile.locator('#rotateButton').click()
    assert mobile.locator('#rotationLabel').inner_text()=='90°'
    mobile.locator('#zoomIn').click()
    assert mobile.locator('#zoomLabel').inner_text()=='150%'
    assert mobile.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
    mobile.screenshot(path=str(folder/'mobile-rotated.png'),full_page=True)
    assert not errors,errors
    print(json.dumps({'rotation_4_directions':'passed','rotated_pointer_and_roi':'passed',
        'rotated_exports':'passed','camera_preview_capture':'passed','camera_close_switch_cleanup':'passed',
        'permission_denied_and_late_stream':'passed','mobile_390px':'passed','page_errors':errors}))
    browser.close()
