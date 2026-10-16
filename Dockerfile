FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
    && groupadd --gid 10001 fieldpos \
    && useradd --uid 10001 --gid 10001 --no-create-home fieldpos
COPY app/ /app/
USER 10001:10001
EXPOSE 8030
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8030/health', timeout=2).close()"]
CMD ["python", "container_server.py"]
