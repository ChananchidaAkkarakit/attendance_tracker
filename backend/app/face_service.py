from insightface.app import FaceAnalysis
import numpy as np
from typing import Optional, Tuple

class FaceService:
    def __init__(self, cpu: bool = True, model_name: str = "buffalo_sc"):
        providers = ["CPUExecutionProvider"] if cpu else None
        self.app = FaceAnalysis(name=model_name, providers=providers)
        self.app.prepare(ctx_id=(-1 if cpu else 0), det_size=(640, 640))

    def extract(self, bgr) -> Optional[Tuple[np.ndarray, list]]:
        faces = self.app.get(bgr)
        if not faces:
            return None
        f = max(faces, key=lambda x:(x.bbox[2]-x.bbox[0])*(x.bbox[3]-x.bbox[1]))
        return f.normed_embedding, f.bbox.astype(int)

    @staticmethod
    def cos(a, b):
        return float(np.dot(a, b))
