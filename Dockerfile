# Multi-stage for smaller image
FROM python:3.12-slim AS builder
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

FROM python:3.12-slim
WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
COPY app/ ./app/
COPY static/ ./static/
ENV PATH="/app/.venv/bin:$PATH"
ENV DATA_DIR=/app/data
ENV APP_PORT=3410
EXPOSE 3410
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3410"]
