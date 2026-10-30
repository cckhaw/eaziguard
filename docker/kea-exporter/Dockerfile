# Thin wrapper around the community kea-exporter (https://pypi.org/project/kea-exporter/).
FROM python:3.12-slim

RUN pip install --no-cache-dir kea-exporter==0.7.1 \
 && useradd --system --no-create-home exporter
USER exporter

EXPOSE 9547
# TARGETS (space-separated Kea Control Agent URLs) is read from the environment.
ENTRYPOINT ["kea-exporter", "--address", "0.0.0.0", "--port", "9547"]
