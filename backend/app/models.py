# app/models.py
from typing import Optional
from sqlmodel import SQLModel, Field
from datetime import datetime, timezone

class Department(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    lat: float
    lng: float
    radius_m: int
    # หมายเหตุ: ตัด Relationship ออกเพื่อเลี่ยงปัญหา mapper/typing ชั่วคราว


class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    email: str = Field(index=True, unique=True)
    name: str
    role: str              # ถ้าอยากเปลี่ยน default ค่อยแก้เป็น "user"
    hashed_password: str
    embeddings_json: Optional[str] = None  # เก็บ list ของ face embeddings เป็น JSON string

    department_id: Optional[int] = Field(default=None, foreign_key="department.id")
    # หมายเหตุ: ไม่ใส่ Relationship เพื่อกันแตกกับ SQLAlchemy 2.x


class Attendance(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    ts: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    action: str = Field(index=True)
    score: float = 0.0
    lat: Optional[float] = None
    lng: Optional[float] = None
    distance_m: Optional[float] = None
    slot: Optional[str] = Field(default=None, max_length=16)


class AttendanceAttempt(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    ts: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    # ...
    # ใคร / เป็นใคร
    user_id: Optional[int] = Field(default=None, foreign_key="user.id", index=True)
    email: Optional[str] = Field(default=None, index=True)  # email ที่ระบบเดา/ระบุได้ (ถ้ามี)

    # พยายามทำอะไร
    action: str = Field(default="in")  # "in" | "out"

    # ผลลัพธ์
    success: bool = False
    reason: Optional[str] = None       # เก็บสาเหตุ เช่น "face not found", "Location accuracy too low", "Out of permitted area", ฯลฯ

    # ข้อมูลวัดผล
    score: Optional[float] = None
    lat: Optional[float] = None
    lng: Optional[float] = None
    accuracy: Optional[float] = None
    distance_m: Optional[float] = None
    department_id: Optional[int] = Field(default=None, foreign_key="department.id")

    # บริบทไคลเอนต์
    client_ip: Optional[str] = None
    user_agent: Optional[str] = None
    slot: Optional[str] = Field(default=None, max_length=16)