FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Not root. The CaptureHost policy drops all capabilities and forbids extra caps,
# so nothing here needs to bind a privileged port.
RUN useradd --uid 10001 --create-home appuser
USER appuser

EXPOSE 8000

# 0.0.0.0, not 127.0.0.1: inside a container, localhost is only the container.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
