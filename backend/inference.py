from __future__ import annotations

from collections import Counter
from pathlib import Path

import cv2
import numpy as np
import torch
import torchvision.transforms as transforms
from PIL import Image

# Keep class order aligned with the provided model.pt.
MODEL_CLASSES = [
    "Alectura_lathami",
    "Antechinus_agilis",
    "Bos_taurus",
    "Burhinus_grallarius",
    "Canis_familiaris",
    "Chalcophaps_longirostris",
    "Colluricincla_harmonica",
    "Corcorax_melanorhamphos",
    "Dacelo_novaeguineae",
    "Dama_dama",
    "Eopsaltria_australis",
    "Felis_catus",
    "Geopelia_humeralis",
    "Gymnorhina_tibicen",
    "Homo_sapiens",
    "Isoodon_macrourus",
    "Lepus_europaeus",
    "Macropus_giganteus",
    "Menura_novaehollandiae",
    "Mus_musculus",
    "Oryctolagus_cuniculus",
    "Perameles_nasuta",
    "Pitta_versicolor",
    "Rattus",
    "Rattus_fuscipes",
    "Rattus_rattus",
    "Strepera_graculina",
    "Sus_scrofa",
    "Tachyglossus_aculeatus",
    "Thylogale_stigmatica",
    "Trichosurus_caninus",
    "Trichosurus_cunninghami",
    "Trichosurus_vulpecula",
    "Varanus_varius",
    "Vombatus_ursinus",
    "Vulpes_vulpes",
    "Wallabia_bicolor",
    "Canis_dingo",
    "Capra_hircus",
    "Casuarius_casuarius",
    "Heteromyias_cinereifrons",
    "Hypsiprymnodon_moschatus",
    "Megapodius_reinwardt",
    "Notamacropus_rufogriseus",
    "Orthonyx_spaldingii",
    "Uromys_caudimaculatus",
]

_MODEL = None
_DEVICE = None

_TRANSFORM = transforms.Compose(
    [
        transforms.Resize((480, 480)),
        transforms.ToTensor(),
    ]
)


def _device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _to_common_name(class_name: str, taxonomy_map: dict[str, str]) -> str:
    key = class_name.lower().replace("_", " ")
    parts = key.split(" ")
    if len(parts) >= 2:
        species_key = f"{parts[0]} {parts[1]}"
        if species_key in taxonomy_map:
            return taxonomy_map[species_key]
    return key


def _load_model(model_path: Path) -> torch.nn.Module:
    global _MODEL, _DEVICE
    if _MODEL is None:
        _DEVICE = _device()
        model = torch.load(str(model_path), map_location=_DEVICE, weights_only=False)
        model.eval()
        model.to(_DEVICE)
        _MODEL = model
    return _MODEL


@torch.no_grad()
def _predict_probs(image: Image.Image, model_path: Path) -> np.ndarray:
    model = _load_model(model_path)
    tensor = _TRANSFORM(image.convert("RGB")).unsqueeze(0).permute(0, 2, 3, 1).to(_DEVICE)
    logits = model(tensor)
    return torch.softmax(logits, dim=1)[0].detach().cpu().numpy()


def _top_tags_from_probs(
    probs: np.ndarray, taxonomy_map: dict[str, str], top_k: int
) -> list[tuple[str, float]]:
    order = np.argsort(probs)[::-1]
    out: list[tuple[str, float]] = []
    for idx in order[:top_k]:
        common_tag = _to_common_name(MODEL_CLASSES[int(idx)], taxonomy_map)
        out.append((common_tag, float(probs[int(idx)])))
    return out


@torch.no_grad()
def detect_image_tags(
    image_path: Path, model_path: Path, taxonomy_map: dict[str, str], top_k: int = 3
) -> tuple[list[str], dict[str, int], str]:
    img = Image.open(image_path).convert("RGB")
    probs = _predict_probs(img, model_path)
    top = _top_tags_from_probs(probs, taxonomy_map, top_k=top_k)
    tags: list[str] = []
    counts: dict[str, int] = {}
    for common_tag, score in top:
        tags.append(common_tag)
        counts[common_tag] = max(1, int(round(score * 3)))
    return tags, counts, "model:image"


def detect_video_tags(
    video_path: Path, model_path: Path, taxonomy_map: dict[str, str], sample_fps: int = 1, max_frames: int = 180
) -> tuple[list[str], dict[str, int], str]:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Unable to open video: {video_path.name}")

    native_fps = cap.get(cv2.CAP_PROP_FPS)
    if not native_fps or native_fps <= 0:
        native_fps = 25.0
    frame_interval = max(1, int(round(native_fps / max(sample_fps, 1))))

    frame_idx = 0
    sampled = 0
    counter: Counter[str] = Counter()
    confidence_acc: dict[str, float] = {}

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if frame_idx % frame_interval == 0:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                img = Image.fromarray(rgb)
                probs = _predict_probs(img, model_path)
                top_tag, top_score = _top_tags_from_probs(probs, taxonomy_map, top_k=1)[0]
                counter[top_tag] += 1
                confidence_acc[top_tag] = confidence_acc.get(top_tag, 0.0) + top_score
                sampled += 1
                if sampled >= max_frames:
                    break
            frame_idx += 1
    finally:
        cap.release()

    if sampled == 0:
        raise RuntimeError("No frames sampled from video")

    ordered_tags = [tag for tag, _ in counter.most_common()]
    tag_counts = {tag: int(counter[tag]) for tag in ordered_tags}
    return ordered_tags, tag_counts, "model:video:1fps"

