"""Optional integration QA; requires Playwright and an already running server.

RICE_TEST_URL=http://127.0.0.1:8000 python tests/browser_smoke.py
RICE_CHROMIUM can select an existing Chromium executable.
All fixtures, downloads and screenshots stay in the ignored work/ directory.
"""
import json
from pathlib import Path
import sys
import os

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'tests'))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from test_detection import rice_scene
from playwright.sync_api import sync_playwright, expect

folder = Path(__file__).resolve().parent.parent / 'work' / 'browser-qa'
folder.mkdir(parents=True, exist_ok=True)
base_url = os.getenv('RICE_TEST_URL', 'http://127.0.0.1:8000')
for name, shadow in [('rice',None),('rice-shadow','smooth'),('rice-hard-shadow','hard')]:
    image, _ = rice_scene(shadow)
    image.save(folder / f'{name}.png')

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.getenv('RICE_CHROMIUM', '/usr/bin/chromium'), args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':1440,'height':1050}, device_scale_factor=1)
    failures = []
    page.on('pageerror', lambda error: failures.append(str(error)))
    page.goto(base_url, wait_until='networkidle')
    page.screenshot(path=str(folder / 'desktop-empty.png'), full_page=True)
    page.locator('#fileInput').set_input_files(str(folder / 'rice.png'))
    page.locator('#detectButton').click()
    expect(page.locator("#count")).to_have_text("20")
    canvas = page.locator('#photoCanvas')
    rectangle = canvas.bounding_box()
    # Add one red dot and remove it using the same real pointer interaction.
    page.mouse.click(rectangle['x'] + rectangle['width'] * .1, rectangle['y'] + rectangle['height'] * .05)
    assert page.locator('#count').inner_text() == '21'
    page.mouse.click(rectangle['x'] + rectangle['width'] * .1, rectangle['y'] + rectangle['height'] * .05)
    assert page.locator('#count').inner_text() == '20'
    page.locator('#undoButton').click()
    assert page.locator('#count').inner_text() == '21'
    page.locator('#undoButton').click()
    assert page.locator('#count').inner_text() == '20'
    page.locator('#confirmButton').click()
    assert page.locator('#resultState').inner_text() == '已人工确认'
    with page.expect_download() as data_download:
        page.locator('#exportData').click()
    data_download.value.save_as(str(folder / 'export.json'))
    data = json.loads((folder / 'export.json').read_text())
    assert data['count'] == len(data['points']) == 20
    assert data['manually_confirmed']
    with page.expect_download() as image_download:
        page.locator('#exportImage').click()
    image_download.value.save_as(str(folder / 'export.jpg'))
    page.screenshot(path=str(folder / 'desktop-result.png'), full_page=True)
    page.locator('#fileInput').set_input_files(str(folder / 'rice-shadow.png'))
    page.locator('#detectButton').click()
    expect(page.locator("#count")).to_have_text("20")
    assert page.locator('#recentPhotos button').count() == 2
    page.locator('#fileInput').set_input_files(str(folder / 'rice-hard-shadow.png'))
    assert page.locator('#recentPhotos button').count() == 2
    assert 'rice.png' not in page.locator('#recentPhotos').inner_text()
    page.locator('#detectButton').click()
    expect(page.locator("#count")).to_have_text("20")
    # Edits require the existing in-app replace confirmation.
    page.locator('.advanced summary').click()
    page.locator('#coordinateX').fill('20')
    page.locator('#coordinateY').fill('20')
    page.locator('#coordinateAdd').click()
    page.locator('#detectButton').click()
    assert page.locator('#replaceDialog').is_visible()
    page.locator('#replaceDialog button[value=cancel]').click()
    assert page.locator('#count').inner_text() == '21'
    page.locator('#detectButton').click()
    page.locator('#replaceDialog button[value=confirm]').click()
    expect(page.locator("#count")).to_have_text("20")
    assert page.evaluate('localStorage.length') == 0
    page.locator('#clearButton').click()
    assert page.locator('#count').inner_text() == '—'
    assert page.locator('#recentPhotos button').count() == 0
    mobile = browser.new_page(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True, device_scale_factor=1)
    mobile.on('pageerror', lambda error: failures.append(str(error)))
    mobile.goto(base_url,wait_until='networkidle')
    assert mobile.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    mobile.screenshot(path=str(folder / 'mobile-empty.png'),full_page=True)
    mobile.locator('#fileInput').set_input_files(str(folder / 'rice-shadow.png'))
    mobile.locator('#detectButton').click()
    expect(mobile.locator("#count")).to_have_text("20")
    assert mobile.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    mobile.locator('#zoomIn').click()
    assert mobile.locator('#zoomLabel').inner_text() == '150%'
    assert mobile.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    mobile.locator('#fitButton').click()
    mobile.screenshot(path=str(folder / 'mobile-result.png'),full_page=True)
    mobile.reload(wait_until='networkidle')
    assert mobile.locator('#count').inner_text() == '—'
    assert not failures, failures
    print(json.dumps({'desktop':'passed','mobile_390px':'passed','exports':'passed','recent_two':'passed','page_errors':failures},ensure_ascii=False))
    browser.close()
