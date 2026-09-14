FROM python:3.12-slim

WORKDIR /app
RUN pip install --no-cache-dir fastapi "uvicorn[standard]" httpx

COPY router/ /app/router/
COPY dashboard/ /app/dashboard/
RUN mkdir -p /app/router_state

EXPOSE 8080
# Single worker on purpose: the router posteriors are in-process state, and a
# second worker would serve a different set of beliefs to every other poll.
CMD ["uvicorn", "dashboard.app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
