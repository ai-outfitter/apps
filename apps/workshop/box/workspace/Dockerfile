FROM docker.io/library/debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-venv prusa-slicer=2.9.2+dfsg-1 \
    && python3 -m venv /opt/cad && /opt/cad/bin/pip install --no-cache-dir \
    trimesh==4.5.3 numpy==2.2.6 scipy==1.15.3 manifold3d==3.5.5 \
    && rm -rf /var/lib/apt/lists/*
COPY --chmod=0444 cantilever.py fdm-asa.ini preflight.py preflight_http.py /opt/workshop/
RUN chmod 0755 /opt/workshop
ENV HOME=/tmp QT_QPA_PLATFORM=offscreen
USER 65534:65534
ENTRYPOINT ["/opt/cad/bin/python", "/opt/workshop/preflight.py"]
