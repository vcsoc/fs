"""CPU preprocessing for the pinned Gemma 4 vision/audio encoder contracts."""
from __future__ import annotations

import math
import os

import numpy as np
from PIL import Image, ImageOps


def image_inputs(image, soft_tokens=280):
    # Match Transformers' Gemma4ImageProcessor: aspect-preserving 16px patches,
    # a 3x3 spatial pooling grid, RGB [0,1], and invalid padded position IDs.
    if soft_tokens not in {70, 140, 280}:
        raise ValueError('Unsupported vision token budget.')
    image = ImageOps.exif_transpose(image).convert('RGB')
    width, height = image.size
    if not width or not height:
        raise ValueError('Empty image.')
    max_patches = soft_tokens * 9
    factor = math.sqrt(max_patches * 256 / (height * width))
    target_h = int(math.floor(height * factor / 48)) * 48
    target_w = int(math.floor(width * factor / 48)) * 48
    if target_h == 0:
        target_h = 48
        target_w = min(max(48, int(width / height) * 48), soft_tokens * 48)
    elif target_w == 0:
        target_w = 48
        target_h = min(max(48, int(height / width) * 48), soft_tokens * 48)
    array = np.asarray(image.resize((target_w, target_h), Image.Resampling.BICUBIC), dtype=np.float32) / 255.0
    rows, columns = target_h // 16, target_w // 16
    patches = array.reshape(rows, 16, columns, 16, 3).transpose(0, 2, 1, 3, 4).reshape(rows * columns, 768)
    x, y = np.meshgrid(np.arange(columns), np.arange(rows))
    positions = np.stack([x, y], axis=-1).reshape(-1, 2).astype(np.int64)
    values = np.zeros((1, max_patches, 768), dtype=np.float32)
    ids = np.full((1, max_patches, 2), -1, dtype=np.int64)
    values[0, :len(patches)] = patches
    ids[0, :len(positions)] = positions
    return {'pixel_values': values, 'pixel_position_ids': ids}


def audio_inputs(samples):
    os.environ.setdefault('TRANSFORMERS_VERBOSITY', 'error')
    from transformers.models.gemma4.feature_extraction_gemma4 import Gemma4AudioFeatureExtractor
    samples = np.asarray(samples, dtype=np.float32)
    if samples.ndim != 1 or len(samples) < 321 or len(samples) > 480000 or not np.isfinite(samples).all():
        raise ValueError('Audio must be finite mono 16 kHz PCM, between 21 ms and 30 seconds.')
    extractor = Gemma4AudioFeatureExtractor()
    # Use the pinned NumPy fbank implementation directly; its public batch
    # wrapper in 5.19.0 transposes a mono waveform into the wrong batch shape.
    features, mask = extractor._extract_spectrogram(samples[None, :], np.ones(len(samples), dtype=np.int64))
    features = features.astype(np.float32) * mask[:, None]
    return {'input_features': features[None, :], 'input_features_mask': mask[None, :].astype(bool)}
