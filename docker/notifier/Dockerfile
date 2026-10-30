# Alertmanager webhook receiver that sends email, SMS and WhatsApp. Standard library only.
FROM python:3.12-slim

WORKDIR /app
COPY notifier.py /app/notifier.py
RUN useradd --system --no-create-home notifier
USER notifier

EXPOSE 9099
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:9099/healthz', timeout=4).status == 200 else 1)"
CMD ["python", "/app/notifier.py"]
