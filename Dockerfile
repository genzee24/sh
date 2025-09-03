FROM tensorflow/tensorflow:1.15.5-gpu-py3

ENV DEBIAN_FRONTEND=noninteractive
# Remove stale NVIDIA repos to avoid the NO_PUBKEY failure
RUN rm -f /etc/apt/sources.list.d/cuda*.list /etc/apt/sources.list.d/nvidia*.list || true \
 && apt-get update && apt-get install -y --no-install-recommends \
    build-essential git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    Flask==2.0.3 Flask-Cors==3.0.10 gunicorn==20.1.0 gevent==22.10.2 \
    numpy==1.19.5 scikit-image==0.17.2 Pillow==8.4.0 imgaug==0.2.9 \
    matplotlib==3.3.4 h5py==2.10.0 Keras==2.2.5

WORKDIR /app
COPY . /app
ENV IMAGES_DIR=/app/images FLASK_ENV=production PYTHONUNBUFFERED=1
EXPOSE 5000
CMD ["gunicorn","-k","gevent","-w","2","-b","0.0.0.0:5000","application:app"]
