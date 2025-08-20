# backend/Dockerfile
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# 1) System libs ที่ OpenCV/InsightFace ต้องใช้
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# 2) Python deps
COPY requirements.txt .
# แนะนำ: ใช้ opencv-python-headless ใน requirements.txt
RUN pip install -r requirements.txt

# 3) โค้ดแอป
COPY app ./app

# 4) โฟลเดอร์สำหรับไฟล์ถาวร (SQLite / โมเดล .onnx)
RUN mkdir -p /app/data /app/models

EXPOSE 8000

# 5) รันด้วย Gunicorn+Uvicorn (เสถียรกว่า uvicorn เดี่ยว)
CMD ["gunicorn", "-k", "uvicorn.workers.UvicornWorker", "app.main:app", "--bind", "0.0.0.0:8000", "--workers", "2", "--timeout", "180"]
