import os

from fastapi import FastAPI

app = FastAPI()
APP_NAME = os.getenv("APP_NAME", "demo")


@app.get("/")
def root():
    return {"ok": True, "app": APP_NAME}


@app.get("/health")
def health():
    return {"status": "healthy"}
