from concurrent.futures import ThreadPoolExecutor
import asyncio
import builtins
from io import BytesIO
import threading
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from starlette.requests import Request

from backend.app import app, processing_slot, detect, active_workers


def photo():
    image = Image.new("RGB", (300, 200), "white")
    ImageDraw.Draw(image).ellipse((80, 60, 100, 120), fill=(184, 144, 60))
    data = BytesIO(); image.save(data, format="PNG")
    return data.getvalue()


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.headers = {"Content-Type": "application/octet-stream"}

    def test_recognition_is_memory_only_and_count_matches_points(self):
        original_open = builtins.open
        writes = []
        def guarded_open(file, mode="r", *args, **kwargs):
            if any(character in mode for character in "wax+"):
                writes.append(str(file))
            return original_open(file, mode, *args, **kwargs)
        with patch("builtins.open", side_effect=guarded_open):
            response = self.client.post("/api/detect", content=photo(), headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["count"], len(result["points"]))
        self.assertEqual(result["count"], 1)
        self.assertFalse(result["image_retained"])
        self.assertEqual(writes, [])
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_payload_reference_is_cleared_on_success_and_failure(self):
        for fail in [False, True]:
            retained = []
            def worker(payload, options):
                retained.append(payload)
                if fail:
                    raise ValueError("failure")
                return {"count":0, "points":[]}
            with patch("backend.app.detect_image", side_effect=worker):
                client = TestClient(app, raise_server_exceptions=False)
                response = client.post("/api/detect", content=photo(), headers=self.headers)
            self.assertEqual(response.status_code, 500 if fail else 200)
            self.assertEqual(len(retained[0]), 0)
            self.assertFalse(processing_slot.locked())

    def test_invalid_empty_and_multipart_requests(self):
        for data, code in [(b"invalid",422), (b"",400)]:
            response = self.client.post("/api/detect", content=data, headers=self.headers)
            self.assertEqual(response.status_code, code)
            self.assertFalse(processing_slot.locked())
        self.assertEqual(self.client.post("/api/detect", files={"file":("a.png",photo())}).status_code, 415)

    def test_size_and_query_limits(self):
        with patch("backend.app.MAX_UPLOAD_BYTES", 10):
            response = self.client.post("/api/detect", content=photo(), headers=self.headers)
            self.assertEqual(response.status_code, 413)
        for query in ["background=bad", "sensitivity=100", "min_area_percent=0", "split=bad", "sensitivity=nan"]:
            self.assertEqual(self.client.post(f"/api/detect?{query}", content=photo(), headers=self.headers).status_code, 422)

    def test_chunked_upload_limit(self):
        with patch("backend.app.MAX_UPLOAD_BYTES", 10):
            response = self.client.post("/api/detect", content=iter([b"123456", b"789012"]), headers=self.headers)
        self.assertEqual(response.status_code, 413)
        self.assertFalse(processing_slot.locked())

    def test_token_is_optional_and_enforced_when_configured(self):
        with patch("backend.app.ACCESS_TOKEN", "secret-token"):
            self.assertTrue(self.client.get("/api/health").json()["requires_token"])
            self.assertEqual(self.client.post("/api/detect", content=photo(), headers=self.headers).status_code, 401)
            response = self.client.post("/api/detect", content=photo(), headers={**self.headers, "Authorization":"Bearer secret-token"})
            self.assertEqual(response.status_code, 200)

    def test_busy_rejected_and_health_remains_responsive(self):
        entered, finish = threading.Event(), threading.Event()
        def blocking(payload, options):
            entered.set()
            if not finish.wait(5):
                raise RuntimeError("test timeout")
            return {"points": [], "count": 0}
        with patch("backend.app.detect_image", side_effect=blocking), ThreadPoolExecutor() as pool:
            future = pool.submit(self.client.post, "/api/detect", content=photo(), headers=self.headers)
            try:
                self.assertTrue(entered.wait(3))
                self.assertEqual(self.client.get("/api/health").status_code, 200)
                busy = self.client.post("/api/detect", content=photo(), headers=self.headers)
                self.assertEqual(busy.status_code, 429)
            finally:
                finish.set()
            self.assertEqual(future.result(timeout=5).status_code, 200)
        self.assertFalse(processing_slot.locked())

    def test_ui_assets_and_security_headers(self):
        for url in ["/", "/assets/app.mjs", "/assets/model.mjs", "/assets/style.css", "/assets/icon.svg"]:
            response = self.client.get(url)
            self.assertEqual(response.status_code, 200)
            self.assertIn("frame-ancestors 'none'", response.headers["content-security-policy"])
        self.assertEqual(self.client.get("/assets/../.env").status_code, 404)


class CancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_request_does_not_release_live_worker_slot(self):
        entered, finish = threading.Event(), threading.Event()
        retained = []
        def worker(payload, options):
            retained.append(payload)
            entered.set()
            if not finish.wait(5):
                raise RuntimeError("test timeout")
            return {"points":[], "count":0}
        body = photo()
        sent = False
        async def receive():
            nonlocal sent
            if not sent:
                sent = True
                return {"type":"http.request", "body":body, "more_body":False}
            return {"type":"http.disconnect"}
        request = Request({"type":"http", "method":"POST", "path":"/api/detect",
            "headers":[(b"content-type",b"application/octet-stream")]}, receive)
        with patch("backend.app.detect_image", side_effect=worker):
            task = asyncio.create_task(detect(request, "paper", 0, .002, "balanced"))
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 3))
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertTrue(processing_slot.locked())
                self.assertGreater(len(retained[0]), 0)
            finally:
                finish.set()
            if active_workers:
                await asyncio.gather(*list(active_workers))
            self.assertFalse(processing_slot.locked())
            self.assertEqual(len(retained[0]), 0)


if __name__ == "__main__":
    unittest.main()
