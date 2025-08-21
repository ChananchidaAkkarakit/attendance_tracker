# backend/app/main.py
from fastapi import FastAPI, Depends, UploadFile, File, Form, HTTPException, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from typing import Optional, Tuple
import cv2
import json
import numpy as np
from math import radians, sin, cos, asin, sqrt
from sqlmodel import Session, select
from starlette.requests import Request
from .models import AttendanceAttempt, Department
from .deps import get_session, get_current_user, require_admin, init_db
from .auth import make_access_token, verify_pw, hash_pw
from .face_service import FaceService
from .models import User, Attendance, Department
from fastapi import Query
from datetime import datetime, timedelta
from fastapi import Depends
from .models import User
from .deps import require_admin
from .deps import require_admin, init_db, engine  # เพิ่ม engine เข้ามาด้วย
import os


# ---------- constants & utils ----------

EARTH_R = 6371000.0
def haversine_m(lat1, lng1, lat2, lng2) -> float:
    dlat = radians(lat2 - lat1); dlng = radians(lng2 - lng1)
    a = sin(dlat/2)**2 + cos(radians(lat1))*cos(radians(lat2))*sin(dlng/2)**2
    return 2 * asin(sqrt(a)) * EARTH_R

# NEW: valid time slots
# valid time slots
VALID_SLOTS = {"morning", "noon", "afternoon", "evening"}

def _validate_slot(slot: str) -> str:
    s = (slot or "").lower()
    if s not in VALID_SLOTS:
        raise HTTPException(400, "invalid slot (use: morning|noon|afternoon|evening)")
    return s
from datetime import datetime, timedelta, timezone

# กำหนดโซนเวลาองค์กร (UTC+7: Bangkok)
BKK_TZ = timezone(timedelta(hours=7))

def derive_slot(now: datetime | None = None) -> str:
    """
    คืนค่า 'morning' | 'noon' | 'afternoon' | 'evening'
    กำหนดช่วงเวลาได้ตามโจทย์/นโยบาย
    """
    t = (now or datetime.now(BKK_TZ)).astimezone(BKK_TZ)
    h = t.hour  # 0-23
    if h < 10:      # 00:00–09:59
        return "morning"
    if h < 13:      # 10:00–12:59
        return "noon"
    if h < 17:      # 13:00–16:59
        return "afternoon"
    return "evening" # 17:00–23:59

# ---------- app & middlewares ----------

app = FastAPI(title="Face Attendance", version="1.0.0")

origins = [
    "https://attendance-tracker-woad-one.vercel.app",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# init db (สร้างตารางอัตโนมัติถ้ายังไม่มี)
init_db()

# --- add 'slot' column if missing (SQLite/Postgres safe) ---
from sqlalchemy import text
with engine.connect() as conn:
    try:
        conn.execute(text("ALTER TABLE attendance ADD COLUMN slot TEXT"))
    except Exception:
        pass
    try:
        conn.execute(text("ALTER TABLE attendanceattempt ADD COLUMN slot TEXT"))
    except Exception:
        pass


# face service
# แทนที่ svc = FaceService(cpu=True)
_svc = None
def get_svc():
    global _svc
    if _svc is None:
        _svc = FaceService(cpu=True)  # ถ้ามี GPU ค่อยเปลี่ยน cpu=False
    return _svc


# ---------- Utility: หา user ที่ใกล้สุด ----------
def best_match_user(emb: np.ndarray, s: Session, th: float = 0.35) -> Tuple[float, Optional[User]]:
    best_score, best_user = -1.0, None
    users = s.exec(select(User)).all()
    for u in users:
        if not u.embeddings_json:
            continue
        targets = [np.array(x, dtype=np.float32) for x in json.loads(u.embeddings_json)]
        if not targets:
            continue
        score = max(float(np.dot(emb, t)) for t in targets)
        if score > best_score:
            best_score, best_user = score, u
    if best_score >= th:
        return best_score, best_user
    return best_score, None


def _get_client_ip_ua(request: Request) -> tuple[str|None, str|None]:
    # รองรับ reverse proxy เบื้องต้น
    ip = request.headers.get("x-forwarded-for") or request.client.host if request.client else None
    ua = request.headers.get("user-agent")
    return ip, ua

def log_attempt(
    s: Session,
    *,
    success: bool,
    me: Optional[User],
    email: Optional[str],
    action: str,
    reason: Optional[str],
    lat: Optional[float],
    lng: Optional[float],
    accuracy: Optional[float],
    score: Optional[float],
    distance_m: Optional[float],
    department_id: Optional[int],
    client_ip: Optional[str],
    user_agent: Optional[str],
    image_path: Optional[str] = None,
    slot: Optional[str] = None,  # ✅ keep this
):
    if slot is None:
        slot = derive_slot()
    rec = AttendanceAttempt(
        user_id = me.id if me else None,
        email = email,
        action = action,
        success = success,
        reason = reason,
        lat = lat, lng = lng, accuracy = accuracy,
        score = score, distance_m = distance_m,
        department_id = department_id,
        client_ip = client_ip,
        user_agent = user_agent,
        image_path = image_path,
        slot = slot,  # ✅ save
    )
    s.add(rec); s.commit()



# ---------- Schemas ----------
class LoginOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    name: str
    email: str

# ---------- Health ----------
@app.get("/api/health")
def health():
    return {"ok": True}

# ---------- Bootstrap admin ครั้งแรก ----------
@app.post("/api/bootstrap-admin")
def bootstrap_admin(
    email: str = Form(...),
    password: str = Form(...),
    name: str = Form("Admin"),
    s: Session = Depends(get_session),
):
    exists = s.exec(select(User).where(User.email == email)).first()
    if exists:
        raise HTTPException(400, "admin exists")
    u = User(email=email, name=name, role="admin", hashed_password=hash_pw(password))
    s.add(u); s.commit(); s.refresh(u)
    return {"ok": True, "id": u.id}

# ---------- Login ----------
@app.post("/api/login", response_model=LoginOut)
def login(form: OAuth2PasswordRequestForm = Depends(), s: Session = Depends(get_session)):
    u = s.exec(select(User).where(User.email == form.username)).first()
    if not u or not verify_pw(form.password, u.hashed_password):
        raise HTTPException(401, "invalid credentials")
    token = make_access_token(u.email, u.role)
    return LoginOut(access_token=token, role=u.role, name=u.name, email=u.email)

# ---------- Admin router ----------
admin = APIRouter(prefix="/api/admin", tags=["admin"])

class DepartmentIn(BaseModel):
    name: str; lat: float; lng: float; radius_m: int = 200

@admin.post("/departments")
def create_department(payload: DepartmentIn,
                      _: User = Depends(require_admin),
                      s: Session = Depends(get_session)):
    dep = Department(**payload.dict()); s.add(dep); s.commit(); s.refresh(dep)
    return {"ok": True, "department": dep}

@admin.get("/departments")
def list_departments(_: User = Depends(require_admin), s: Session = Depends(get_session)):
    items = s.exec(select(Department).order_by(Department.name)).all()
    return {"items": items}

class AssignDepartmentIn(BaseModel):
    user_id: int; department_id: int

@admin.post("/assign-department")
def assign_department(payload: AssignDepartmentIn,
                      _: User = Depends(require_admin),
                      s: Session = Depends(get_session)):
    u = s.get(User, payload.user_id); dep = s.get(Department, payload.department_id)
    if not u or not dep: raise HTTPException(404, "User or Department not found")
    u.department_id = dep.id; s.add(u); s.commit()
    return {"ok": True}

@admin.get("/attendance-attempts")
def list_attempts(
    success: Optional[bool] = Query(None),
    email: Optional[str] = Query(None),
    action: Optional[str] = Query(None),
    days: int = Query(7, ge=1, le=90),
    s: Session = Depends(get_session),
    _: User = Depends(require_admin),
):
    since = datetime.utcnow() - timedelta(days=days)
    q = select(AttendanceAttempt).where(AttendanceAttempt.ts >= since).order_by(AttendanceAttempt.ts.desc())
    if success is not None:
        q = q.where(AttendanceAttempt.success == success)
    if email:
        q = q.where(AttendanceAttempt.email == email)
    if action in ("in", "out"):
        q = q.where(AttendanceAttempt.action == action)
    items = s.exec(q).all()
    return {"items": items}

@app.post("/api/admin/users")
def create_user(
    email: str = Form(...),
    name: str = Form(...),
    password: str = Form(...),
    _: User = Depends(require_admin),
    s: Session = Depends(get_session),
):
    if s.exec(select(User).where(User.email == email)).first():
        raise HTTPException(400, "email exists")
    u = User(email=email, name=name, role="user", hashed_password=hash_pw(password))

    s.add(u); s.commit(); s.refresh(u)
    return {"ok": True, "id": u.id}

@app.post("/api/admin/enroll")
def admin_enroll(
    email: str = Form(...),
    files: list[UploadFile] = File(...),
    _: User = Depends(require_admin),
    s: Session = Depends(get_session),
):
    u = s.exec(select(User).where(User.email == email)).first()
    if not u:
        raise HTTPException(404, "user not found")
    embs = json.loads(u.embeddings_json) if u.embeddings_json else []
    added = 0
    for f in files:
        data = f.file.read()
        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        res = svc.extract(img)
        if res:
            emb, _ = res
            embs.append(emb.tolist())
            added += 1
    if not added:
        raise HTTPException(400, "no usable faces")
    u.embeddings_json = json.dumps(embs)
    s.add(u); s.commit()
    return {"ok": True, "added": added, "total": len(embs)}

@app.post("/api/admin/recognize")
def admin_recognize(
    file: UploadFile = File(...),
    th: float = 0.35,
    _: User = Depends(require_admin),
    s: Session = Depends(get_session),
):
    data = file.file.read()
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    res = svc.extract(img)
    if not res:
        raise HTTPException(400, "face not found")
    emb, _ = res

    score, u = best_match_user(emb, s, th=th)
    if not u:
        return {"found": False, "score": score}
    return {"found": True, "score": score, "user": {"id": u.id, "email": u.email, "name": u.name}}

# ---------- include admin router ----------
app.include_router(admin)

# ---------- Attendance helpers ----------
def last_attendance(s: Session, user_id: int):
    return s.exec(
        select(Attendance).where(Attendance.user_id == user_id).order_by(Attendance.ts.desc())
    ).first()

# ---------- User: Clock-in ----------
from starlette.requests import Request

@app.post("/api/attendance/clock-in")
def clock_in(
    request: Request,
    file: UploadFile = File(...),
    lat: float = Form(...),
    lng: float = Form(...),
    accuracy: Optional[float] = Form(None),
    th: float = 0.35,
    me: User = Depends(get_current_user),
    s: Session = Depends(get_session),
):
    ip, ua = _get_client_ip_ua(request)

    # ตรวจ preconditions
    if not me.embeddings_json:
        log_attempt(s, success=False, me=me, email=me.email, action="in",
            reason="no enrolled face for this user",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(400, "no enrolled face for this user")

    if not me.department_id:
        log_attempt(s, success=False, me=me, email=me.email, action="in",
            reason="No department assigned",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=None, client_ip=ip, user_agent=ua)
        raise HTTPException(403, "No department assigned")

    dep = s.get(Department, me.department_id)
    if not dep:
        log_attempt(s, success=False, me=me, email=me.email, action="in",
            reason="Department not found",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(403, "Department not found")

    if accuracy is not None and accuracy > 100:
        log_attempt(s, success=False, me=me, email=me.email, action="in",
            reason="Location accuracy too low",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua, )
        raise HTTPException(400, "Location accuracy too low")

    # อ่านรูป & ฝังใบหน้า
    data = file.file.read()
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    res = svc.extract(img)
    if not res:
        log_attempt(s, success=False, me=me, email=me.email, action="in",
            reason="face not found",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(400, "face not found")

    emb, _ = res
    targets = [np.array(x, dtype=np.float32) for x in json.loads(me.embeddings_json)]
    best = max(float(np.dot(emb, t)) for t in targets) if targets else -1.0
    if best < th:
        log_attempt(s, success=False, me=me, email=me.email, action="in",
            reason=f"face mismatch (score={best:.2f} < th={th})",
            lat=lat, lng=lng, accuracy=accuracy, score=best, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(403, f"face mismatch (score={best:.2f} < th={th})")

    dist_m = haversine_m(dep.lat, dep.lng, lat, lng)
    allow_radius = (dep.radius_m or 200) + (accuracy or 0.0)
    if dist_m > allow_radius:
        log_attempt(s, success=False, me=me, email=me.email, action="in",
            reason=f"Out of permitted area: {int(dist_m)}m > {int(allow_radius)}m",
            lat=lat, lng=lng, accuracy=accuracy, score=best, distance_m=dist_m,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(403, f"Out of permitted area: {int(dist_m)}m > {int(allow_radius)}m")

    # สำเร็จ → บันทึก Attendance + Attempt(success)
    rec = Attendance(user_id=me.id, score=best, action="in", lat=lat, lng=lng, distance_m=dist_m)
    s.add(rec); s.commit(); s.refresh(rec)

    log_attempt(s, success=True, me=me, email=me.email, action="in",
        reason=None, lat=lat, lng=lng, accuracy=accuracy, score=best, distance_m=dist_m,
        department_id=me.department_id, client_ip=ip, user_agent=ua)

    return {"ok": True, "action":"in", "score":best, "distance_m":int(dist_m), "attendance_id":rec.id,
            "user":{"id":me.id,"email":me.email,"name":me.name}}


# ---------- User: Clock-out ----------
@app.post("/api/attendance/clock-out")
def clock_out(
    request: Request,
    file: UploadFile = File(...),
    lat: float = Form(...),
    lng: float = Form(...),
    accuracy: Optional[float] = Form(None),
    th: float = 0.35,
    me: User = Depends(get_current_user),
    s: Session = Depends(get_session),
):
    action = "out"
    ip, ua = _get_client_ip_ua(request)

    # ตรวจ preconditions
    if not me.embeddings_json:
        log_attempt(s, success=False, me=me, email=me.email, action=action,
            reason="no enrolled face for this user",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(400, "no enrolled face for this user")

    last = last_attendance(s, me.id)
    if not last or last.action != "in":
        log_attempt(s, success=False, me=me, email=me.email, action=action,
            reason="not clocked in yet",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(400, "not clocked in yet")

    if not me.department_id:
        log_attempt(s, success=False, me=me, email=me.email, action=action,
            reason="No department assigned",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=None, client_ip=ip, user_agent=ua)
        raise HTTPException(403, "No department assigned")

    dep = s.get(Department, me.department_id)
    if not dep:
        log_attempt(s, success=False, me=me, email=me.email, action=action,
            reason="Department not found",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(403, "Department not found")

    if accuracy is not None and accuracy > 100:
        log_attempt(s, success=False, me=me, email=me.email, action=action,
            reason="Location accuracy too low",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(400, "Location accuracy too low")

    # อ่านรูป & ฝังใบหน้า
    data = file.file.read()
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    res = svc.extract(img)
    if not res:
        log_attempt(s, success=False, me=me, email=me.email, action=action,
            reason="face not found",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(400, "face not found")

    emb, _ = res
    targets = [np.array(x, dtype=np.float32) for x in json.loads(me.embeddings_json)]
    best = max(float(np.dot(emb, t)) for t in targets) if targets else -1.0
    if best < th:
        log_attempt(s, success=False, me=me, email=me.email, action=action,
            reason=f"face mismatch (score={best:.2f} < th={th})",
            lat=lat, lng=lng, accuracy=accuracy, score=best, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(403, f"face mismatch (score={best:.2f} < th={th})")

    dist_m = haversine_m(dep.lat, dep.lng, lat, lng)
    allow_radius = (dep.radius_m or 200) + (accuracy or 0.0)
    if dist_m > allow_radius:
        log_attempt(s, success=False, me=me, email=me.email, action=action,
            reason=f"Out of permitted area: {int(dist_m)}m > {int(allow_radius)}m",
            lat=lat, lng=lng, accuracy=accuracy, score=best, distance_m=dist_m,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(403, f"Out of permitted area: {int(dist_m)}m > {int(allow_radius)}m")

    # สำเร็จ → บันทึก Attendance + Attempt(success)
    rec = Attendance(user_id=me.id, score=best, action=action, lat=lat, lng=lng, distance_m=dist_m)
    s.add(rec); s.commit(); s.refresh(rec)

    log_attempt(s, success=True, me=me, email=me.email, action=action,
        reason=None, lat=lat, lng=lng, accuracy=accuracy, score=best, distance_m=dist_m,
        department_id=me.department_id, client_ip=ip, user_agent=ua)

    return {"ok": True, "action": action, "score": best, "distance_m": int(dist_m), "attendance_id": rec.id,
            "user": {"id": me.id, "email": me.email, "name": me.name}}

# backend/app/main.py
from fastapi import FastAPI, Depends, UploadFile, File, Form, HTTPException, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from typing import Optional, Tuple
import cv2
import json
import numpy as np
from math import radians, sin, cos, asin, sqrt
from sqlmodel import Session, select
from starlette.requests import Request
from .models import AttendanceAttempt, Department
from .deps import get_session, get_current_user, require_admin, init_db
from .auth import make_access_token, verify_pw, hash_pw
from .face_service import FaceService
from .models import User, Attendance, Department
from fastapi import Query
from datetime import datetime, timedelta

# ---------- constants & utils ----------
EARTH_R = 6371000.0
def haversine_m(lat1, lng1, lat2, lng2) -> float:
    dlat = radians(lat2 - lat1); dlng = radians(lng2 - lng1)
    a = sin(dlat/2)**2 + cos(radians(lat1))*cos(radians(lat2))*sin(dlng/2)**2
    return 2 * asin(sqrt(a)) * EARTH_R

# ---------- app & middlewares ----------
app = FastAPI(title="Face Attendance", version="1.0.0")

# CORS: DEV ใช้ * ง่ายกว่า (ห้าม credentials); ถ้าต้องการ credentials ระบุโดเมนให้ตรง
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],  # ปรับตามโดเมน frontend ของคุณ
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# init db (สร้างตารางอัตโนมัติถ้ายังไม่มี)
init_db()

# face service
svc = FaceService(cpu=True)  # ถ้ามี GPU → cpu=False

# ---------- Utility: หา user ที่ใกล้สุด ----------
def best_match_user(emb: np.ndarray, s: Session, th: float = 0.35) -> Tuple[float, Optional[User]]:
    best_score, best_user = -1.0, None
    users = s.exec(select(User)).all()
    for u in users:
        if not u.embeddings_json:
            continue
        targets = [np.array(x, dtype=np.float32) for x in json.loads(u.embeddings_json)]
        if not targets:
            continue
        score = max(float(np.dot(emb, t)) for t in targets)
        if score > best_score:
            best_score, best_user = score, u
    if best_score >= th:
        return best_score, best_user
    return best_score, None


def _get_client_ip_ua(request: Request) -> tuple[str|None, str|None]:
    # รองรับ reverse proxy เบื้องต้น
    ip = request.headers.get("x-forwarded-for") or request.client.host if request.client else None
    ua = request.headers.get("user-agent")
    return ip, ua

def log_attempt(
    s: Session,
    *,
    success: bool,
    me: Optional[User],
    email: Optional[str],
    action: str,
    reason: Optional[str],
    lat: Optional[float],
    lng: Optional[float],
    accuracy: Optional[float],
    score: Optional[float],
    distance_m: Optional[float],
    department_id: Optional[int],
    client_ip: Optional[str],
    user_agent: Optional[str],
    image_path: Optional[str] = None,
    slot: Optional[str] = None,  # ✅ keep this
):
    if slot is None:
        slot = derive_slot()
    rec = AttendanceAttempt(
        user_id = me.id if me else None,
        email = email,
        action = action,
        success = success,
        reason = reason,
        lat = lat, lng = lng, accuracy = accuracy,
        score = score, distance_m = distance_m,
        department_id = department_id,
        client_ip = client_ip,
        user_agent = user_agent,
        image_path = image_path,
        slot = slot,  # ✅ save
    )
    s.add(rec); s.commit()


# ---------- Schemas ----------
class LoginOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    name: str
    email: str

# ---------- Health ----------
@app.get("/api/health")
def health():
    return {"ok": True}

# ---------- Bootstrap admin ครั้งแรก ----------
@app.post("/api/bootstrap-admin")
def bootstrap_admin(
    email: str = Form(...),
    password: str = Form(...),
    name: str = Form("Admin"),
    s: Session = Depends(get_session),
):
    exists = s.exec(select(User).where(User.email == email)).first()
    if exists:
        raise HTTPException(400, "admin exists")
    u = User(email=email, name=name, role="admin", hashed_password=hash_pw(password))
    s.add(u); s.commit(); s.refresh(u)
    return {"ok": True, "id": u.id}

# ---------- Login ----------
@app.post("/api/login", response_model=LoginOut)
def login(form: OAuth2PasswordRequestForm = Depends(), s: Session = Depends(get_session)):
    u = s.exec(select(User).where(User.email == form.username)).first()
    if not u or not verify_pw(form.password, u.hashed_password):
        raise HTTPException(401, "invalid credentials")
    token = make_access_token(u.email, u.role)
    return LoginOut(access_token=token, role=u.role, name=u.name, email=u.email)

# ---------- Admin router ----------
admin = APIRouter(prefix="/api/admin", tags=["admin"])

class DepartmentIn(BaseModel):
    name: str; lat: float; lng: float; radius_m: int = 200

@admin.get("/me")
def admin_me(me: User = Depends(require_admin)):
    return {
        "id": me.id,
        "email": me.email,
        "name": me.name,
        "role": me.role,
    }

@admin.post("/departments")
def create_department(payload: DepartmentIn,
                      _: User = Depends(require_admin),
                      s: Session = Depends(get_session)):
    dep = Department(**payload.dict()); s.add(dep); s.commit(); s.refresh(dep)
    return {"ok": True, "department": dep}

@admin.get("/departments")
def list_departments(_: User = Depends(require_admin), s: Session = Depends(get_session)):
    items = s.exec(select(Department).order_by(Department.name)).all()
    return {"items": items}

class AssignDepartmentIn(BaseModel):
    user_id: int; department_id: int

@admin.post("/assign-department")
def assign_department(payload: AssignDepartmentIn,
                      _: User = Depends(require_admin),
                      s: Session = Depends(get_session)):
    u = s.get(User, payload.user_id); dep = s.get(Department, payload.department_id)
    if not u or not dep: raise HTTPException(404, "User or Department not found")
    u.department_id = dep.id; s.add(u); s.commit()
    return {"ok": True}

@admin.get("/attendance-attempts")
def list_attempts(
    success: Optional[bool] = Query(None),
    email: Optional[str] = Query(None),
    action: Optional[str] = Query(None),
    days: int = Query(7, ge=1, le=90),
    s: Session = Depends(get_session),
    _: User = Depends(require_admin),
):
    since = datetime.utcnow() - timedelta(days=days)
    q = select(AttendanceAttempt).where(AttendanceAttempt.ts >= since).order_by(AttendanceAttempt.ts.desc())
    if success is not None:
        q = q.where(AttendanceAttempt.success == success)
    if email:
        q = q.where(AttendanceAttempt.email == email)
    if action in ("in", "out"):
        q = q.where(AttendanceAttempt.action == action)
    items = s.exec(q).all()
    return {"items": items}

@app.post("/api/admin/users")
def create_user(
    email: str = Form(...),
    name: str = Form(...),
    password: str = Form(...),
    _: User = Depends(require_admin),
    s: Session = Depends(get_session),
):
    if s.exec(select(User).where(User.email == email)).first():
        raise HTTPException(400, "email exists")
    u = User(email=email, name=name, role="user", hashed_password=hash_pw(password))

    s.add(u); s.commit(); s.refresh(u)
    return {"ok": True, "id": u.id}

@app.post("/api/admin/enroll")
def admin_enroll(
    email: str = Form(...),
    files: list[UploadFile] = File(...),
    _: User = Depends(require_admin),
    s: Session = Depends(get_session),
):
    u = s.exec(select(User).where(User.email == email)).first()
    if not u:
        raise HTTPException(404, "user not found")
    embs = json.loads(u.embeddings_json) if u.embeddings_json else []
    added = 0
    for f in files:
        data = f.file.read()
        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        res = svc.extract(img)
        if res:
            emb, _ = res
            embs.append(emb.tolist())
            added += 1
    if not added:
        raise HTTPException(400, "no usable faces")
    u.embeddings_json = json.dumps(embs)
    s.add(u); s.commit()
    return {"ok": True, "added": added, "total": len(embs)}

@app.post("/api/admin/recognize")
def admin_recognize(
    file: UploadFile = File(...),
    th: float = 0.35,
    _: User = Depends(require_admin),
    s: Session = Depends(get_session),
):
    data = file.file.read()
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    res = svc.extract(img)
    if not res:
        raise HTTPException(400, "face not found")
    emb, _ = res

    score, u = best_match_user(emb, s, th=th)
    if not u:
        return {"found": False, "score": score}
    return {"found": True, "score": score, "user": {"id": u.id, "email": u.email, "name": u.name}}

# ---------- include admin router ----------
app.include_router(admin)

# ---------- Attendance helpers ----------
def last_attendance(s: Session, user_id: int):
    return s.exec(
        select(Attendance).where(Attendance.user_id == user_id).order_by(Attendance.ts.desc())
    ).first()

# ---------- User: Clock-in ----------
@app.post("/api/attendance/clock-in")
def clock_in(
    request: Request,
    file: UploadFile = File(...),
    lat: float = Form(...),
    lng: float = Form(...),
    accuracy: Optional[float] = Form(None),
    slot: Optional[str] = Form(None), 
    th: float = 0.35,
    me: User = Depends(get_current_user),
    s: Session = Depends(get_session),
):
    slot = derive_slot()   
    ip, ua = _get_client_ip_ua(request)

    # (เหมือนเดิมทั้งหมดด้านล่างนี้)
    if not me.embeddings_json:
        log_attempt(s, success=False, me=me, email=me.email, action="in",
            reason="no enrolled face for this user",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(400, "no enrolled face for this user")

    if not me.department_id:
        log_attempt(s, success=False, me=me, email=me.email, action="in",
            reason="No department assigned",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=None, client_ip=ip, user_agent=ua)
        raise HTTPException(403, "No department assigned")

    dep = s.get(Department, me.department_id)
    if not dep:
        log_attempt(s, success=False, me=me, email=me.email, action="in",
            reason="Department not found",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(403, "Department not found")

    if accuracy is not None and accuracy > 100:
        log_attempt(s, success=False, me=me, email=me.email, action="in",
            reason="Location accuracy too low",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(400, "Location accuracy too low")

    data = file.file.read()
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    res = svc.extract(img)
    if not res:
        log_attempt(s, success=False, me=me, email=me.email, action="in",
            reason="face not found",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(400, "face not found")

    emb, _ = res
    targets = [np.array(x, dtype=np.float32) for x in json.loads(me.embeddings_json)]
    best = max(float(np.dot(emb, t)) for t in targets) if targets else -1.0
    if best < th:
        log_attempt(s, success=False, me=me, email=me.email, action="in",
            reason=f"face mismatch (score={best:.2f} < th={th})",
            lat=lat, lng=lng, accuracy=accuracy, score=best, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(403, f"face mismatch (score={best:.2f} < th={th})")

    dist_m = haversine_m(dep.lat, dep.lng, lat, lng)
    allow_radius = (dep.radius_m or 200) + (accuracy or 0.0)
    if dist_m > allow_radius:
        log_attempt(s, success=False, me=me, email=me.email, action="in",
            reason=f"Out of permitted area: {int(dist_m)}m > {int(allow_radius)}m",
            lat=lat, lng=lng, accuracy=accuracy, score=best, distance_m=dist_m,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(403, f"Out of permitted area: {int(dist_m)}m > {int(allow_radius)}m")

    slot = derive_slot()

# when success (clock-in)
    rec = Attendance(
        user_id=me.id, score=best, action="in",
        lat=lat, lng=lng, distance_m=dist_m,
        slot=slot
    )
    s.add(rec); s.commit(); s.refresh(rec)

    log_attempt(
        s, success=True, me=me, email=me.email, action="in",
        reason=None, lat=lat, lng=lng, accuracy=accuracy, score=best, distance_m=dist_m,
        department_id=me.department_id, client_ip=ip, user_agent=ua,
        slot=slot  # ✅ add this
    )

    return {
        "ok": True, "action": "in", "slot": slot,  # ✅ echo to frontend
        "score": best, "distance_m": int(dist_m), "attendance_id": rec.id,
        "user": {"id": me.id, "email": me.email, "name": me.name}
}

# ---------- User: Clock-out ----------
@app.post("/api/attendance/clock-out")
def clock_out(
    request: Request,
    file: UploadFile = File(...),
    lat: float = Form(...),
    lng: float = Form(...),
    accuracy: Optional[float] = Form(None),
    slot: Optional[str] = Form(None), 
    th: float = 0.35,
    me: User = Depends(get_current_user),
    s: Session = Depends(get_session),
):
    slot = derive_slot()   
    action = "out"
    ip, ua = _get_client_ip_ua(request)

    if not me.embeddings_json:
        log_attempt(s, success=False, me=me, email=me.email, action=action,
            reason="no enrolled face for this user",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(400, "no enrolled face for this user")

    last = last_attendance(s, me.id)
    if not last or last.action != "in":
        log_attempt(s, success=False, me=me, email=me.email, action=action,
            reason="not clocked in yet",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(400, "not clocked in yet")

    if not me.department_id:
        log_attempt(s, success=False, me=me, email=me.email, action=action,
            reason="No department assigned",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=None, client_ip=ip, user_agent=ua)
        raise HTTPException(403, "No department assigned")

    dep = s.get(Department, me.department_id)
    if not dep:
        log_attempt(s, success=False, me=me, email=me.email, action=action,
            reason="Department not found",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(403, "Department not found")

    if accuracy is not None and accuracy > 100:
        log_attempt(s, success=False, me=me, email=me.email, action=action,
            reason="Location accuracy too low",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(400, "Location accuracy too low")

    data = file.file.read()
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    res = svc.extract(img)
    if not res:
        log_attempt(s, success=False, me=me, email=me.email, action=action,
            reason="face not found",
            lat=lat, lng=lng, accuracy=accuracy, score=None, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(400, "face not found")

    emb, _ = res
    targets = [np.array(x, dtype=np.float32) for x in json.loads(me.embeddings_json)]
    best = max(float(np.dot(emb, t)) for t in targets) if targets else -1.0
    if best < th:
        log_attempt(s, success=False, me=me, email=me.email, action=action,
            reason=f"face mismatch (score={best:.2f} < th={th})",
            lat=lat, lng=lng, accuracy=accuracy, score=best, distance_m=None,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(403, f"face mismatch (score={best:.2f} < th={th})")

    dist_m = haversine_m(dep.lat, dep.lng, lat, lng)
    allow_radius = (dep.radius_m or 200) + (accuracy or 0.0)
    if dist_m > allow_radius:
        log_attempt(s, success=False, me=me, email=me.email, action=action,
            reason=f"Out of permitted area: {int(dist_m)}m > {int(allow_radius)}m",
            lat=lat, lng=lng, accuracy=accuracy, score=best, distance_m=dist_m,
            department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(403, f"Out of permitted area: {int(dist_m)}m > {int(allow_radius)}m")

    rec = Attendance(
        user_id=me.id, score=best, action=action,
        lat=lat, lng=lng, distance_m=dist_m,
        slot=slot                    # <<< NEW
    )
    s.add(rec); s.commit(); s.refresh(rec)

    log_attempt(s, success=True, me=me, email=me.email, action=action,
        reason=None, lat=lat, lng=lng, accuracy=accuracy, score=best, distance_m=dist_m,
        department_id=me.department_id, client_ip=ip, user_agent=ua)

    return {"ok": True, "action": action, "slot": slot,   # <<< NEW
            "score": best, "distance_m": int(dist_m), "attendance_id": rec.id,
            "user": {"id": me.id, "email": me.email, "name": me.name}}


# ---------- Manual clock-in/out (no face) ----------
from fastapi import Body

def _check_department_and_distance(me: User, lat: float, lng: float,
                                   accuracy: Optional[float], s: Session) -> tuple[Department, float, float]:
    if not me.department_id:
        raise HTTPException(403, "No department assigned")
    dep = s.get(Department, me.department_id)
    if not dep:
        raise HTTPException(403, "Department not found")
    if accuracy is not None and accuracy > 100:
        raise HTTPException(400, "Location accuracy too low")
    dist_m = haversine_m(dep.lat, dep.lng, lat, lng)
    allow_radius = (dep.radius_m or 200) + (accuracy or 0.0)
    if dist_m > allow_radius:
        raise HTTPException(403, f"Out of permitted area: {int(dist_m)}m > {int(allow_radius)}m")
    return dep, dist_m, allow_radius


@app.post("/api/attendance/manual-in")
def manual_in(
    request: Request,
    lat: float = Form(...),
    lng: float = Form(...),
    accuracy: Optional[float] = Form(None),
    slot: Optional[str] = Form(None), 
    me: User = Depends(get_current_user),
    s: Session = Depends(get_session),
):
    slot = derive_slot()   
    ip, ua = _get_client_ip_ua(request)
    dep, dist_m, _ = _check_department_and_distance(me, lat, lng, accuracy, s)

    rec = Attendance(
        user_id=me.id, score=None, action="in",
        lat=lat, lng=lng, distance_m=dist_m,
        slot=slot                    # <<< NEW
    )
    s.add(rec); s.commit(); s.refresh(rec)

    log_attempt(s, success=True, me=me, email=me.email, action="in",
                reason="manual", lat=lat, lng=lng, accuracy=accuracy, score=None,
                distance_m=dist_m, department_id=dep.id, client_ip=ip, user_agent=ua)

    return {"ok": True, "action": "in", "slot": slot,   # <<< NEW
            "attendance_id": rec.id, "distance_m": int(dist_m),
            "user": {"id": me.id, "email": me.email, "name": me.name}}

@app.post("/api/attendance/manual-out")
def manual_out(
    request: Request,
    lat: float = Form(...),
    lng: float = Form(...),
    accuracy: Optional[float] = Form(None),
    slot: Optional[str] = Form(None), 
    me: User = Depends(get_current_user),
    s: Session = Depends(get_session),
):
    slot = derive_slot()   
    ip, ua = _get_client_ip_ua(request)

    last = last_attendance(s, me.id)
    if not last or last.action != "in":
        log_attempt(s, success=False, me=me, email=me.email, action="out",
                    reason="not clocked in yet (manual)", lat=lat, lng=lng, accuracy=accuracy,
                    score=None, distance_m=None, department_id=me.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(400, "not clocked in yet")

    dep, dist_m, _ = _check_department_and_distance(me, lat, lng, accuracy, s)

    rec = Attendance(
        user_id=me.id, score=None, action="out",
        lat=lat, lng=lng, distance_m=dist_m,
        slot=slot                    # <<< NEW
    )
    s.add(rec); s.commit(); s.refresh(rec)

    log_attempt(s, success=True, me=me, email=me.email, action="out",
                reason="manual", lat=lat, lng=lng, accuracy=accuracy, score=None,
                distance_m=dist_m, department_id=dep.id, client_ip=ip, user_agent=ua)

    return {"ok": True, "action": "out", "slot": slot,   # <<< NEW
            "attendance_id": rec.id, "distance_m": int(dist_m),
            "user": {"id": me.id, "email": me.email, "name": me.name}}


# ---------- Anonymous face-scan clock (no login) ----------
from fastapi import Depends
@app.post("/api/attendance/anonymous-clock")
def anonymous_clock(
    request: Request,
    action: str = Form(...),                  # "in" | "out"
    file: UploadFile = File(...),
    lat: float = Form(...),
    lng: float = Form(...),
    accuracy: Optional[float] = Form(None),
    slot: Optional[str] = Form(None), 
    th: float = 0.35,
    s: Session = Depends(get_session),
):
    slot = derive_slot()   
    ip, ua = _get_client_ip_ua(request)
    if action not in ("in", "out"):
        raise HTTPException(400, "invalid action")

    data = file.file.read()
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    res = svc.extract(img)
    if not res:
        log_attempt(s, success=False, me=None, email=None, action=action,
            reason="face not found", lat=lat, lng=lng, accuracy=accuracy,
            score=None, distance_m=None, department_id=None, client_ip=ip, user_agent=ua)
        raise HTTPException(400, "face not found")

    emb, _ = res
    score, u = best_match_user(emb, s, th=th)
    if not u:
        log_attempt(s, success=False, me=None, email=None, action=action,
            reason=f"face mismatch (score={score:.2f} < th={th})", lat=lat, lng=lng,
            accuracy=accuracy, score=score, distance_m=None, department_id=None,
            client_ip=ip, user_agent=ua)
        raise HTTPException(401, "face not recognized")

    if not u.embeddings_json: raise HTTPException(400, "no enrolled face for this user")
    if not u.department_id:   raise HTTPException(403, "No department assigned")
    dep = s.get(Department, u.department_id)
    if not dep:               raise HTTPException(403, "Department not found")
    if accuracy is not None and accuracy > 100:
        raise HTTPException(400, "Location accuracy too low")

    dist_m = haversine_m(dep.lat, dep.lng, lat, lng)
    allow_radius = (dep.radius_m or 200) + (accuracy or 0.0)
    if dist_m > allow_radius:
        log_attempt(s, success=False, me=u, email=u.email, action=action,
            reason=f"Out of permitted area: {int(dist_m)}m > {int(allow_radius)}m",
            lat=lat, lng=lng, accuracy=accuracy, score=score, distance_m=dist_m,
            department_id=u.department_id, client_ip=ip, user_agent=ua)
        raise HTTPException(403, f"Out of permitted area: {int(dist_m)}m > {int(allow_radius)}m")

    if action == "out":
        last = last_attendance(s, u.id)
        if not last or last.action != "in":
            raise HTTPException(400, "not clocked in yet")

    rec = Attendance(
        user_id=u.id, score=score, action=action,
        lat=lat, lng=lng, distance_m=dist_m,
        slot=slot                           # <<< NEW
    )
    s.add(rec); s.commit(); s.refresh(rec)

    log_attempt(s, success=True, me=u, email=u.email, action=action, reason=None,
        lat=lat, lng=lng, accuracy=accuracy, score=score, distance_m=dist_m,
        department_id=u.department_id, client_ip=ip, user_agent=ua)

    return {"ok": True, "action": action, "slot": slot,   # <<< NEW
            "score": score, "distance_m": int(dist_m),
            "attendance_id": rec.id,
            "user": {"id": u.id, "email": u.email, "name": u.name}}
