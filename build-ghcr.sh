# login to github via echo GITHUB_TOKEN | docker login ghcr.io -u lingosandi --password-stdin

docker build \
  --build-arg ROOTFS_ARTIFACT_URL="https://github.com/lingosandi/mono-sandbox/releases/download/1.0.0/ubuntu-rootfs-v1.0.0-20260201-164710.ext4.zst" \
  -t ghcr.io/lingosandi/mono-sandbox:1.0.0 \
  -t ghcr.io/lingosandi/mono-sandbox:latest \
  .

docker push ghcr.io/lingosandi/mono-sandbox:1.0.0
docker push ghcr.io/lingosandi/mono-sandbox:latest