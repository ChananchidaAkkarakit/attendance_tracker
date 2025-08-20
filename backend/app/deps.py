# backend/app/deps.py
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlmodel import Session, SQLModel, create_engine, select
from jose import jwt, JWTError
from pathlib import Path
import os

# นำเข้าทุกโมเดล เพื่อให้ create_all รู้จักทุกตาราง
from .models import User, Attendance, Department

# ---- DB path แบบเสถียร (อิงไฟล์นี้) ----
BASE_DIR = Path(__file__).resolve().parent           # .../backend/app
DB_PATH  = BASE_DIR / "db.sqlite3"                   # .../backend/app/db.sqlite3
DB_URL   = os.getenv("DB_URL", f"sqlite:///{DB_PATH}")

# สร้างโฟลเดอร์เผื่อไม่มี (กัน error 'unable to open database file')
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

engine = create_engine(
    DB_URL,
    connect_args={"check_same_thread": False} if DB_URL.startswith("sqlite") else {},
)

def init_db():
    SQLModel.metadata.create_all(engine)

oauth2 = OAuth2PasswordBearer(tokenUrl="/api/login")
JWT_SECRET = os.getenv("JWT_SECRET", "CHANGE_ME")
ALG = "HS256"

def get_session():
    with Session(engine) as s:
        yield s

def get_current_user(token: str = Depends(oauth2), s: Session = Depends(get_session)) -> User:
    try:
        data = jwt.decode(token, JWT_SECRET, algorithms=[ALG])
        email = data.get("sub")
        u = s.exec(select(User).where(User.email == email)).first()
        if not u:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
        return u
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

def require_admin(u: User = Depends(get_current_user)) -> User:
    if u.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    return u
