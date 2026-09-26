# syntax=docker/dockerfile:1.7
# Build from services/quant: docker build -t kora-quant services/quant
FROM python:3.12-slim AS run
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install --upgrade pip && pip install . && useradd --system --uid 10001 kora
USER kora
EXPOSE 8000
CMD ["uvicorn", "kora_quant.app:app", "--host", "0.0.0.0", "--port", "8000"]
