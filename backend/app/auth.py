from datetime import datetime, timedelta
from jose import jwt
from passlib.hash import bcrypt
import os

SECRET = os.getenv("JWT_SECRET", "CHANGE_ME")
ALG = "HS256"
ACCESS_MIN = int(os.getenv("JWT_TTL_MIN", "120"))

def hash_pw(pw: str) -> str:
    return bcrypt.hash(pw)

def verify_pw(pw: str, hashv: str) -> bool:
    return bcrypt.verify(pw, hashv)

def make_access_token(sub: str, role: str):
    payload = {
        "sub": sub,
        "role": role,
        "exp": datetime.utcnow() + timedelta(minutes=ACCESS_MIN)
    }
    return jwt.encode(payload, SECRET, algorithm=ALG)
