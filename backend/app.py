"""Same-origin UI and memory-only, single-flight CPU recognition service."""

import asyncio
import hashlib
import hmac
import os
from pathlib import Path
import threading
import time

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect

from .detection import ImageError, Options, detect_image

ROOT = Path(__file__).resolve().parent.parent
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
UPLOAD_TIMEOUT_SECONDS = 45
ACCESS_TOKEN = os.getenv("RICE_ACCESS_TOKEN", "")
processing_slot = threading.Lock()
active_workers: set[asyncio.Task] = set()

app = FastAPI(title="稻粒计数", docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def privacy_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; "
        "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; "
        "frame-ancestors 'none'; form-action 'self'"
    )
    return response


@app.get("/api/health")
def health():
    return {"status": "ok", "requires_token": bool(ACCESS_TOKEN), "max_upload_bytes": MAX_UPLOAD_BYTES}


@app.post("/api/detect")
async def detect(
    request: Request,
    background: str = Query("paper", pattern="^(paper|auto|dark|light)$"),
    sensitivity: float = Query(0, ge=-40, le=40),
    min_area_percent: float = Query(0.002, ge=0.0002, le=0.2),
    split: str = Query("balanced", pattern="^(off|balanced|strong)$"),
):
    if ACCESS_TOKEN:
        supplied = request.headers.get("authorization", "").removeprefix("Bearer ")
        if not hmac.compare_digest(hashlib.sha256(supplied.encode()).digest(), hashlib.sha256(ACCESS_TOKEN.encode()).digest()):
            raise HTTPException(401, "请输入正确的访问口令。")
    content_type = request.headers.get("content-type", "").split(";")[0].lower()
    if content_type not in {"application/octet-stream", "image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(415, "请直接上传 JPG、PNG 或 WebP 图片数据。")
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            length = int(content_length)
        except ValueError:
            raise HTTPException(400, "上传长度无效。") from None
        if length < 0 or length > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "照片不能超过 20 MB。")
    # Reject busy requests before reading their image body; no memory-heavy queue.
    if not processing_slot.acquire(blocking=False):
        raise HTTPException(429, "服务器正在识别另一张照片，请稍后重试。", headers={"Retry-After": "3"})
    payload = bytearray()
    handed_off = False
    started = time.monotonic()
    try:
        try:
            async with asyncio.timeout(UPLOAD_TIMEOUT_SECONDS):
                async for chunk in request.stream():
                    if len(payload) + len(chunk) > MAX_UPLOAD_BYTES:
                        raise HTTPException(413, "照片不能超过 20 MB。")
                    payload.extend(chunk)
        except TimeoutError:
            raise HTTPException(408, "照片上传超时，请检查网络后重试。") from None
        except ClientDisconnect:
            raise HTTPException(400, "上传已中断。") from None
        if not payload:
            raise HTTPException(400, "没有收到照片。")
        try:
            # The worker owns both buffer and slot after hand-off. Closing a
            # browser cannot free them prematurely while CPU work is running.
            def process():
                try:
                    return detect_image(payload, Options(background, sensitivity, min_area_percent, split))
                finally:
                    payload.clear()
                    processing_slot.release()

            task = asyncio.create_task(run_in_threadpool(process))
            active_workers.add(task)
            def completed(finished):
                active_workers.discard(finished)
                if not finished.cancelled():
                    finished.exception()  # consume failures after a client disconnect
            task.add_done_callback(completed)
            handed_off = True
            result = await asyncio.shield(task)
        except ImageError as exc:
            raise HTTPException(422, str(exc)) from None
        result["elapsed_ms"] = round((time.monotonic() - started) * 1000)
        result["image_retained"] = False
        return JSONResponse(result)
    finally:
        if not handed_off:
            payload.clear()
            processing_slot.release()


@app.get("/")
def index():
    return FileResponse(ROOT / "frontend" / "index.html")


app.mount("/assets", StaticFiles(directory=ROOT / "frontend"), name="assets")
