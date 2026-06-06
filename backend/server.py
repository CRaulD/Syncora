from __future__ import annotations

import ctypes
import json
import os
import queue
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

try:
    from babelfish import Language
    from subliminal import download_best_subtitles, region as subliminal_region
    from subliminal import save_subtitles as subliminal_save_subtitles
    from subliminal import scan_video

    SUBLIMINAL_AVAILABLE = True
except Exception:
    Language = None
    download_best_subtitles = None
    subliminal_region = None
    subliminal_save_subtitles = None
    scan_video = None
    SUBLIMINAL_AVAILABLE = False

VIDEO_EXTS = {".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v"}
SUB_EXTS = {".srt", ".ass", ".ssa", ".vtt"}


def default_runtime_dir() -> Path:
    override = os.environ.get("SYNCORA_RUNTIME_DIR", "").strip()
    if override:
        return Path(override).expanduser()

    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
        if base:
            return Path(base) / "Syncora" / "runtime"

    return Path.home() / ".syncora" / "runtime"


RUNTIME_DIR = default_runtime_dir()
MANIFEST_PATH = RUNTIME_DIR / "manifest.json"
PROVIDERS_PATH = RUNTIME_DIR / "providers.json"
HTTP_HEADERS = {"User-Agent": "Syncora/0.1.0"}
SUBLIMINAL_REGION_READY = False

if sys.platform == "win32":
    try:
        ctypes.windll.kernel32.SetErrorMode(0x0001 | 0x0002 | 0x8000)
    except Exception:
        pass

SUBPROCESS_FLAGS = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" and hasattr(subprocess, "CREATE_NO_WINDOW") else 0
SYNC_JOBS: dict[str, dict] = {}
SYNC_JOBS_LOCK = threading.Lock()
PROVIDER_RATE_LOCK = threading.Lock()
PROVIDER_NEXT_REQUEST_AT: dict[str, float] = {}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sync_job_event(job: dict, event_type: str, payload: Optional[dict] = None) -> dict:
    payload = payload or {}
    with SYNC_JOBS_LOCK:
        seq = int(job.get("next_seq", 1))
        event = {"seq": seq, "type": event_type, "ts": utc_now(), **payload}
        job["next_seq"] = seq + 1
        job.setdefault("events", []).append(event)
        if len(job["events"]) > 4000:
            job["events"] = job["events"][-2000:]
        job["updated_at"] = event["ts"]
    queue_obj: Optional[queue.Queue] = job.get("queue")
    if queue_obj is not None:
        try:
            queue_obj.put_nowait(event)
        except Exception:
            pass
    return event


def get_sync_job(job_id: str) -> Optional[dict]:
    with SYNC_JOBS_LOCK:
        return SYNC_JOBS.get(job_id)


def remove_old_sync_jobs(max_age_seconds: int = 3600) -> None:
    now = time.time()
    with SYNC_JOBS_LOCK:
        stale_ids = []
        for job_id, job in SYNC_JOBS.items():
            updated_at = str(job.get("updated_at", ""))
            age = 0.0
            try:
                age = now - datetime.fromisoformat(updated_at.replace("Z", "+00:00")).timestamp()
            except Exception:
                age = 0.0
            if job.get("status") in {"done", "failed", "cancelled"} and age > max_age_seconds:
                stale_ids.append(job_id)
        for job_id in stale_ids:
            SYNC_JOBS.pop(job_id, None)


def fetch_json(url: str, timeout: int) -> dict:
    req = urllib.request.Request(url, headers=HTTP_HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def download_bytes(url: str, timeout: int) -> bytes:
    req = urllib.request.Request(url, headers=HTTP_HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def request_json(url: str, timeout: int = 30, headers: Optional[dict] = None, data: Optional[dict] = None) -> dict:
    merged_headers = {**HTTP_HEADERS, **(headers or {})}
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        merged_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, headers=merged_headers, data=body)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def request_bytes(url: str, timeout: int = 60, headers: Optional[dict] = None) -> bytes:
    req = urllib.request.Request(url, headers={**HTTP_HEADERS, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def provider_min_interval(provider_id: str) -> float:
    return {
        "subsource": 1.2,
        "subdl": 1.0,
        "opensubtitles": 1.0,
    }.get(provider_id, 0.0)


def provider_cooldown_remaining(provider_id: str) -> float:
    with PROVIDER_RATE_LOCK:
        wait_until = PROVIDER_NEXT_REQUEST_AT.get(provider_id, 0.0)
    return max(0.0, wait_until - time.monotonic())


def wait_provider_turn(provider_id: str) -> None:
    interval = provider_min_interval(provider_id)
    if interval <= 0:
        return
    with PROVIDER_RATE_LOCK:
        now = time.monotonic()
        wait_until = PROVIDER_NEXT_REQUEST_AT.get(provider_id, 0.0)
        wait_seconds = max(0.0, wait_until - now)
        PROVIDER_NEXT_REQUEST_AT[provider_id] = max(now, wait_until) + interval
    if wait_seconds > 0:
        time.sleep(wait_seconds)


def postpone_provider(provider_id: str, delay_seconds: float) -> None:
    if delay_seconds <= 0:
        return
    with PROVIDER_RATE_LOCK:
        PROVIDER_NEXT_REQUEST_AT[provider_id] = max(
            PROVIDER_NEXT_REQUEST_AT.get(provider_id, 0.0),
            time.monotonic() + delay_seconds,
        )


def retry_after_seconds(exc: urllib.error.HTTPError, fallback: float) -> float:
    raw_value = ""
    try:
        raw_value = str(exc.headers.get("Retry-After") or "").strip()
    except Exception:
        raw_value = ""
    if raw_value.isdigit():
        return max(float(raw_value), fallback)
    return fallback


def with_query_param(url: str, key: str, value: str) -> str:
    if not value:
        return url
    parsed = urllib.parse.urlparse(url)
    query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
    query[key] = value
    return urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(query)))


def normalize_subdl_download_url(raw_value: str) -> str:
    value = str(raw_value or "").strip()
    if value.startswith("https://") or value.startswith("http://"):
        return value
    if value.startswith("/"):
        return f"https://dl.subdl.com{value}"
    return f"https://dl.subdl.com/{value}"


def normalize_stem(name: str) -> str:
    cleaned = name.lower()
    for token in [".pt-br", ".ptbr", ".eng", ".en", ".es", ".fr", ".ger", ".ita"]:
        if cleaned.endswith(token):
            cleaned = cleaned[: -len(token)]
    return cleaned


def language_for_subdl(code: str) -> str:
    c = normalize_lang(code)
    if c in {"pt-br", "ptbr"}:
        return "BR_PT"
    if c.startswith("pt"):
        return "PT"
    if c == "en":
        return "EN"
    if c == "es":
        return "ES"
    return c.upper()


def subdl_error_message(exc: Exception) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        body_text = ""
        try:
            body_text = exc.read().decode("utf-8", errors="ignore")
        except Exception:
            body_text = ""
        detail = ""
        if body_text:
            try:
                payload = json.loads(body_text)
                detail = str(payload.get("message") or payload.get("error") or "").strip()
            except Exception:
                detail = body_text.strip()
        if not detail:
            detail = str(exc.reason or "").strip()
        if exc.code == 403:
            detail = f"API key do SubDL recusada. {detail}".strip()
        return f"HTTP {exc.code}: {detail}" if detail else f"HTTP {exc.code}"
    return str(exc)


def subdl_request_json(params: dict, timeout: int = 30) -> dict:
    url = "https://api.subdl.com/api/v1/subtitles?" + urllib.parse.urlencode(params)
    try:
        wait_provider_turn("subdl")
        data = request_json(url, timeout)
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            postpone_provider("subdl", retry_after_seconds(exc, 60.0))
        raise RuntimeError(subdl_error_message(exc)) from exc
    except Exception as exc:
        raise RuntimeError(subdl_error_message(exc)) from exc
    if not data.get("status"):
        raise RuntimeError(str(data.get("message") or data.get("error") or "Resposta invalida do SubDL"))
    return data


def language_for_opensubtitles(code: str) -> str:
    c = normalize_lang(code)
    if c == "pt":
        return "pt-br"
    return c or "pt-br"


def clean_title_from_filename(name: str) -> str:
    stem = Path(name).stem
    normalized = re.sub(r"[._-]+", " ", stem)
    episode = re.search(r"\bS\d{1,2}\s*E\d{1,3}\b", normalized, re.I)
    if episode:
        return re.sub(r"\s+", " ", normalized[: episode.end()]).strip()
    year = re.search(r"\b(19|20)\d{2}\b", normalized)
    if year:
        return re.sub(r"\s+", " ", normalized[: year.end()]).strip()
    normalized = re.sub(
        r"\b(1080p|720p|2160p|480p|WEB\s?DL|WEBRip|BluRay|BRRip|HDRip|HDTV|DVDRip|REMUX|x264|x265|H\s?264|H\s?265|HEVC|AAC|DDP?5\s?1|DTS|10bit|8bit)\b.*$",
        "",
        normalized,
        flags=re.I,
    )
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized or Path(name).stem


def episode_from_filename(name: str) -> tuple[Optional[int], Optional[int]]:
    match = re.search(r"S(\d{1,2})E(\d{1,3})", name, re.I)
    if not match:
        return None, None
    return int(match.group(1)), int(match.group(2))


def score_subtitle(video_name: str, release_name: str) -> int:
    video_tokens = set(re.findall(r"[a-z0-9]+", video_name.lower()))
    release_tokens = set(re.findall(r"[a-z0-9]+", release_name.lower()))
    return len(video_tokens & release_tokens)


def episode_match_score(release_name: str, season: Optional[int], episode: Optional[int]) -> int:
    if season is None or episode is None:
        return 0
    text = str(release_name or "").lower()
    compact = re.sub(r"[\s._-]+", "", text)
    target_tokens = {
        f"s{season:02d}e{episode:02d}",
        f"s{season}e{episode:02d}",
        f"{season}x{episode:02d}",
    }
    if any(token in compact for token in target_tokens):
        return 80
    se_match = re.search(r"s(\d{1,2})e(\d{1,3})", compact, re.I)
    if se_match:
        try:
            found_season = int(se_match.group(1))
            found_episode = int(se_match.group(2))
            if found_season != season or found_episode != episode:
                return -1000
        except Exception:
            pass
    x_match = re.search(r"\b(\d{1,2})x(\d{1,3})\b", text, re.I)
    if x_match:
        try:
            found_season = int(x_match.group(1))
            found_episode = int(x_match.group(2))
            if found_season != season or found_episode != episode:
                return -1000
        except Exception:
            pass
    return 0


def opensubtitles_movie_hash(video: Path) -> Optional[tuple[str, int]]:
    try:
        size = video.stat().st_size
        if size < 131072:
            return None
        total = size
        with open(video, "rb") as fh:
            for chunk in (fh.read(65536),):
                for value in struct.unpack("<8192Q", chunk):
                    total = (total + value) & 0xFFFFFFFFFFFFFFFF
            fh.seek(max(0, size - 65536))
            chunk = fh.read(65536)
            for value in struct.unpack("<8192Q", chunk):
                total = (total + value) & 0xFFFFFFFFFFFFFFFF
        return f"{total:016x}", size
    except Exception:
        return None


def extract_subtitle_archive(payload: bytes, destination: Path, preferred_name: str) -> Path:
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(delete=False, suffix=".zip") as tmp:
        tmp_path = Path(tmp.name)
        tmp_path.write_bytes(payload)
    try:
        with zipfile.ZipFile(tmp_path, "r") as zf:
            candidates = [n for n in zf.namelist() if Path(n).suffix.lower() in SUB_EXTS and not n.endswith("/")]
            if not candidates:
                raise RuntimeError("Arquivo baixado não contém legenda suportada")
            best = sorted(candidates, key=lambda n: (Path(n).suffix.lower() != ".srt", len(n)))[0]
            out = destination / f"{preferred_name}{Path(best).suffix.lower()}"
            with zf.open(best) as src, open(out, "wb") as dst:
                shutil.copyfileobj(src, dst)
            return normalize_subtitle_to_utf8(out)
    finally:
        tmp_path.unlink(missing_ok=True)


def save_subtitle_payload(payload: bytes, content_name: str, destination: Path, preferred_name: str) -> Path:
    suffix = Path(content_name).suffix.lower()
    if suffix == ".zip":
        return extract_subtitle_archive(payload, destination, preferred_name)
    if suffix not in SUB_EXTS:
        suffix = ".srt"
    destination.mkdir(parents=True, exist_ok=True)
    out = destination / f"{preferred_name}{suffix}"
    out.write_bytes(payload)
    return normalize_subtitle_to_utf8(out)


def normalize_subtitle_to_utf8(subtitle_path: Path) -> Path:
    raw = subtitle_path.read_bytes()
    text = None
    for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        text = raw.decode("latin-1", errors="replace")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    subtitle_path.write_text(text, encoding="utf-8", newline="\n")
    return subtitle_path


def opensubtitles_login_if_needed(config: dict) -> None:
    if config.get("token"):
        return
    if not config.get("username") or not config.get("password"):
        # API key alone is enough for many public endpoints; test with /infos/user only when token exists.
        return
    try:
        data = request_json(
            "https://api.opensubtitles.com/api/v1/login",
            30,
            {"Api-Key": str(config.get("api_key", "")), "User-Agent": "Syncora/0.1.0"},
            {"username": config["username"], "password": config["password"]},
        )
    except Exception as exc:
        raise RuntimeError(opensubtitles_error_message(exc)) from exc
    token = data.get("token")
    if not token:
        raise RuntimeError("OpenSubtitles não retornou token")
    config["token"] = token
    config["base_url"] = data.get("base_url") or "api.opensubtitles.com"


def opensubtitles_error_message(exc: Exception) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        body_text = ""
        try:
            body_text = exc.read().decode("utf-8", errors="ignore")
        except Exception:
            body_text = ""
        detail = ""
        if body_text:
            try:
                payload = json.loads(body_text)
                detail = str(payload.get("message") or payload.get("error") or payload.get("detail") or "").strip()
            except Exception:
                if re.search(r"<\s*html|<\s*body|<!doctype", body_text, flags=re.I):
                    detail = ""
                else:
                    detail = body_text.strip()
        if not detail:
            detail = str(exc.reason or "").strip()
        friendly = {
            401: "autenticacao recusada. Confira API key, usuario e senha",
            403: "acesso recusado ou limite da conta atingido",
            429: "limite de requisicoes atingido. Tente novamente mais tarde",
            503: "endpoint da API respondeu 503. Pode ser instabilidade, bloqueio temporario ou limite do OpenSubtitles",
        }.get(exc.code)
        if friendly:
            detail = f"{friendly}. {detail}".strip() if detail else friendly
        return f"HTTP {exc.code}: {detail}" if detail else f"HTTP {exc.code}"
    return str(exc)


def opensubtitles_request_json(path: str, config: dict, timeout: int = 30, data: Optional[dict] = None, params: Optional[dict] = None) -> dict:
    opensubtitles_login_if_needed(config)
    base_url = config.get("base_url") or "api.opensubtitles.com"
    query = urllib.parse.urlencode(params or {})
    url = f"https://{base_url}/api/v1{path}"
    if query:
        url = f"{url}?{query}"
    try:
        wait_provider_turn("opensubtitles")
        return request_json(url, timeout, provider_headers("opensubtitles", config), data)
    except urllib.error.HTTPError as exc:
        if exc.code in {429, 503}:
            postpone_provider("opensubtitles", retry_after_seconds(exc, 60.0 if exc.code == 429 else 120.0))
        if exc.code == 401 and config.get("token") and config.get("username") and config.get("password"):
            config["token"] = ""
            opensubtitles_login_if_needed(config)
            try:
                wait_provider_turn("opensubtitles")
                return request_json(url, timeout, provider_headers("opensubtitles", config), data)
            except Exception as retry_exc:
                raise RuntimeError(opensubtitles_error_message(retry_exc)) from retry_exc
        raise RuntimeError(opensubtitles_error_message(exc)) from exc
    except Exception as exc:
        raise RuntimeError(opensubtitles_error_message(exc)) from exc


def opensubtitles_user_info(config: dict) -> dict:
    if not config.get("username") or not config.get("password"):
        config["account_info"] = {}
        return {}
    data = opensubtitles_request_json("/infos/user", config, 30)
    info = data.get("data") if isinstance(data.get("data"), dict) else data
    if not isinstance(info, dict):
        info = {}
    if not info.get("username") and config.get("username"):
        info = {**info, "username": config.get("username")}
    config["account_info"] = normalize_opensubtitles_account_info(info)
    return config["account_info"]


def search_subdl(video: Path, language: str, config: dict) -> list[dict]:
    season, episode = episode_from_filename(video.name)
    params_base = {
        "api_key": config.get("api_key", ""),
        "languages": language_for_subdl(language),
        "subs_per_page": 10,
        "releases": 1,
        "unpack": 1,
    }
    if season and episode:
        params_base["type"] = "tv"
        params_base["season_number"] = season
        params_base["episode_number"] = episode

    attempts = [{**params_base, "file_name": video.name}]
    title_query = clean_title_from_filename(video.name)
    if title_query and title_query.lower() != video.name.lower():
        attempts.append({**params_base, "film_name": title_query})

    subtitles = []
    for params in attempts:
        data = subdl_request_json(params, 30)
        subtitles = data.get("subtitles") or []
        if subtitles:
            break

    results = []
    seen_urls: set[str] = set()
    for item in subtitles:
        unpack_files = item.get("unpack_files") or []
        if unpack_files:
            for unpacked in unpack_files:
                url_part = unpacked.get("url")
                if not url_part:
                    continue
                release = str(unpacked.get("release_name") or unpacked.get("name") or item.get("release_name") or "")
                item_score = score_subtitle(video.name, release) + episode_match_score(release or url_part, season, episode)
                if item_score < 0:
                    continue
                download_url = normalize_subdl_download_url(url_part)
                if download_url in seen_urls:
                    continue
                seen_urls.add(download_url)
                results.append(
                    {
                        "provider": "subdl",
                        "id": url_part,
                        "name": release or "SubDL subtitle",
                        "language": unpacked.get("language") or language,
                        "score": item_score,
                        "download_url": download_url,
                    }
                )
        elif item.get("url"):
            release = str(item.get("release_name") or item.get("name") or "")
            url_part = item["url"]
            item_score = score_subtitle(video.name, release) + episode_match_score(release or url_part, season, episode)
            if item_score < 0:
                continue
            download_url = normalize_subdl_download_url(url_part)
            if download_url in seen_urls:
                continue
            seen_urls.add(download_url)
            results.append(
                {
                    "provider": "subdl",
                    "id": url_part,
                    "name": release or "SubDL subtitle",
                    "language": language,
                    "score": item_score,
                    "download_url": download_url,
                }
            )
    return sorted(results, key=lambda x: x.get("score", 0), reverse=True)


def search_opensubtitles(video: Path, language: str, config: dict) -> list[dict]:
    def parse_results(data: dict, match_source: str) -> list[dict]:
        parsed = []
        for item in data.get("data", []):
            attrs = item.get("attributes", {})
            files = attrs.get("files") or []
            if not files:
                continue
            release = str(attrs.get("release") or attrs.get("feature_details", {}).get("title") or "")
            file_id = files[0].get("file_id")
            if not file_id:
                continue
            score = score_subtitle(video.name, release)
            if match_source == "hash":
                score += 10000
            parsed.append(
                {
                    "provider": "opensubtitles",
                    "id": str(file_id),
                    "name": release or "OpenSubtitles subtitle",
                    "language": attrs.get("language") or language,
                    "score": score,
                    "download_url": str(file_id),
                    "match_source": match_source,
                    "compatible": match_source == "hash",
                }
            )
        return parsed

    hash_info = opensubtitles_movie_hash(video)
    if hash_info:
        movie_hash, movie_size = hash_info
        hash_params = {
            "moviehash": movie_hash,
            "moviebytesize": movie_size,
            "languages": language_for_opensubtitles(language),
        }
        try:
            hash_data = opensubtitles_request_json("/subtitles", config, 30, params=hash_params)
            hash_results = parse_results(hash_data, "hash")
            if hash_results:
                return sorted(hash_results, key=lambda x: x.get("score", 0), reverse=True)
        except Exception:
            try:
                hash_data = opensubtitles_request_json(
                    "/subtitles",
                    config,
                    30,
                    params={"moviehash": movie_hash, "languages": language_for_opensubtitles(language)},
                )
                hash_results = parse_results(hash_data, "hash")
                if hash_results:
                    return sorted(hash_results, key=lambda x: x.get("score", 0), reverse=True)
            except Exception:
                pass

    params = {"query": clean_title_from_filename(video.name), "languages": language_for_opensubtitles(language)}
    season, episode = episode_from_filename(video.name)
    if season and episode:
        params["season_number"] = season
        params["episode_number"] = episode
    data = opensubtitles_request_json("/subtitles", config, 30, params=params)
    results = parse_results(data, "name")
    return sorted(results, key=lambda x: x.get("score", 0), reverse=True)


def search_subsource(video: Path, language: str, config: dict) -> list[dict]:
    query_full = clean_title_from_filename(video.name)
    season, episode = episode_from_filename(video.name)
    stem = Path(video.name).stem
    normalized_stem = re.sub(r"[._-]+", " ", stem)

    # Base da série/filme sem o marcador de episódio.
    base_title = re.sub(r"\bS\d{1,2}\s*E\d{1,3}\b", "", query_full, flags=re.I).strip()
    if not base_title:
        base_title = re.sub(r"\bS\d{1,2}\s*E\d{1,3}\b", "", normalized_stem, flags=re.I).strip()
    base_title = re.sub(r"\s+", " ", base_title).strip()

    year_match = re.search(r"\b(19|20)\d{2}\b", normalized_stem)
    year_value = year_match.group(0) if year_match else ""

    query_candidates = [query_full]
    if base_title and year_value:
        query_candidates.append(f"{base_title} {year_value}")
    if base_title:
        query_candidates.append(base_title)

    # Remove duplicados mantendo ordem.
    seen_queries: set[str] = set()
    deduped_queries = []
    for q in query_candidates:
        qq = re.sub(r"\s+", " ", str(q or "")).strip()
        if qq and qq.lower() not in seen_queries:
            seen_queries.add(qq.lower())
            deduped_queries.append(qq)

    movies_by_id: dict[str, dict] = {}
    for q_index, query in enumerate(deduped_queries):
        search_data = subsource_request_json(
            "/movies/search",
            config,
            {"searchType": "text", "q": query, "limit": 20},
            timeout=30,
        )
        movies = search_data.get("data") or []
        if not isinstance(movies, list):
            movies = []
        for movie in movies:
            movie_id = movie.get("movieId") or movie.get("id") or movie.get("_id")
            if not movie_id:
                continue
            key = str(movie_id)
            existing = movies_by_id.get(key)
            if existing is None:
                movie_copy = dict(movie)
                movie_copy["_query_index"] = q_index
                movies_by_id[key] = movie_copy
            else:
                # Prefere a query mais específica (índice menor).
                prev_q_index = int(existing.get("_query_index", 99))
                if q_index < prev_q_index:
                    movie_copy = dict(movie)
                    movie_copy["_query_index"] = q_index
                    movies_by_id[key] = movie_copy

    if not movies_by_id:
        return []

    movies = list(movies_by_id.values())

    def movie_rank(movie: dict) -> tuple[int, int, int, int, int]:
        movie_type = str(movie.get("type") or "").lower()
        movie_season = movie.get("season")
        season_score = 0
        if season is not None:
            try:
                season_num = int(movie_season)
                if season_num == season:
                    season_score = 3
                elif abs(season_num - season) == 1:
                    season_score = 1
            except Exception:
                season_score = 0
        type_score = 1 if season is not None and movie_type == "tvseries" else 0
        title_score = score_subtitle(base_title or video.name, str(movie.get("title") or ""))
        subtitle_count = 0
        try:
            subtitle_count = int(movie.get("subtitleCount") or 0)
        except Exception:
            subtitle_count = 0
        query_score = max(0, 3 - int(movie.get("_query_index", 99)))
        return season_score, type_score, query_score, title_score, subtitle_count

    ordered_movies = sorted(movies, key=movie_rank, reverse=True)
    language_value = language_for_subsource(language)
    requested_lang_norm = normalize_lang(language)
    results = []
    seen_ids: set[str] = set()

    def fetch_subtitles_for_movie(movie_id: int) -> list[dict]:
        params_base: dict[str, str | int] = {"movieId": movie_id, "language": language_value, "limit": 120}

        # No SubSource o releaseInfo costuma ser estrito; tenta e cai para buscas amplas.
        attempts: list[dict[str, str | int]] = []
        if season is not None and episode is not None:
            attempts.append({**params_base, "releaseInfo": f"S{season:02d}E{episode:02d}"})
        if season is not None:
            attempts.append({**params_base, "releaseInfo": f"S{season:02d}"})
        attempts.append(dict(params_base))

        for params in attempts:
            data = subsource_request_json("/subtitles", config, params, timeout=30)
            items = data.get("data") or []
            if isinstance(items, list) and items:
                return items
        return []

    for movie in ordered_movies[:10]:
        movie_id = movie.get("movieId") or movie.get("id") or movie.get("_id")
        if not movie_id:
            continue
        subtitles = fetch_subtitles_for_movie(int(movie_id))
        for item in subtitles:
            sub_id = item.get("subtitleId") or item.get("id") or item.get("_id")
            if not sub_id:
                continue
            sub_id_str = str(sub_id)
            if sub_id_str in seen_ids:
                continue
            seen_ids.add(sub_id_str)
            release_info = item.get("releaseInfo") or []
            if isinstance(release_info, list):
                release_parts = [str(x).strip() for x in release_info if str(x).strip()]
                release = " | ".join(release_parts[:3])
                full_release_text = " ".join(release_parts).lower()
            else:
                release = str(release_info or "")
                full_release_text = release.lower()
            if not release:
                release = str(item.get("title") or item.get("name") or "")
                full_release_text = release.lower()

            item_lang = str(item.get("language") or language_value)
            score = score_subtitle(video.name, release)
            if normalize_lang(item_lang) == requested_lang_norm:
                score += 20
            if season is not None and episode is not None:
                se_token = f"s{season:02d}e{episode:02d}".lower()
                s_token = f"s{season:02d}".lower()
                if se_token in full_release_text:
                    score += 40
                elif s_token in full_release_text:
                    score += 15
                wrong_season = re.search(r"s(\d{2})e(\d{2,3})", full_release_text, re.I)
                if wrong_season:
                    try:
                        if int(wrong_season.group(1)) != season:
                            score -= 30
                    except Exception:
                        pass

            results.append(
                {
                    "provider": "subsource",
                    "id": sub_id_str,
                    "name": release or "SubSource subtitle",
                    "language": item_lang,
                    "score": score,
                    "download_url": sub_id_str,
                }
            )
    return sorted(results, key=lambda x: x.get("score", 0), reverse=True)


def search_provider(video: Path, language: str, provider_id: str, config: dict) -> list[dict]:
    if provider_id == "subdl":
        return search_subdl(video, language, config)
    if provider_id == "opensubtitles":
        return search_opensubtitles(video, language, config)
    if provider_id == "subsource":
        return search_subsource(video, language, config)
    return []


def download_provider_subtitle(candidate: dict, video: Path, destination: Path, language: str, config: dict) -> Path:
    preferred_name = f"{video.stem}.{candidate['provider']}.{normalize_lang(language) or 'sub'}"
    if candidate["provider"] == "subdl":
        download_url = with_query_param(candidate["download_url"], "api_key", str(config.get("api_key", "")))
        payload = request_bytes(download_url, 90, {"x-api-key": str(config.get("api_key", ""))})
        return save_subtitle_payload(payload, candidate["download_url"], destination, preferred_name)
    if candidate["provider"] == "subsource":
        payload = subsource_request_bytes(f"/subtitles/{candidate['id']}/download", config, timeout=90)
        return save_subtitle_payload(payload, f"{candidate['id']}.zip", destination, preferred_name)
    if candidate["provider"] == "opensubtitles":
        opensubtitles_login_if_needed(config)
        if not config.get("token"):
            raise RuntimeError("OpenSubtitles precisa de usuário e senha para baixar pela API oficial")
        data = opensubtitles_request_json("/download", config, 30, data={"file_id": int(candidate["id"])})
        link = data.get("link")
        if not link:
            raise RuntimeError("OpenSubtitles não retornou link de download")
        payload = request_bytes(link, 90)
        return save_subtitle_payload(payload, link, destination, preferred_name)
    raise RuntimeError("Provedor desconhecido")


def ensure_subliminal_region() -> None:
    global SUBLIMINAL_REGION_READY
    if SUBLIMINAL_REGION_READY:
        return
    if not SUBLIMINAL_AVAILABLE or subliminal_region is None:
        raise RuntimeError("Subliminal não está instalado")
    subliminal_region.configure("dogpile.cache.memory")
    SUBLIMINAL_REGION_READY = True


def fetch_subtitle_with_subliminal(video: Path, output_dir: Path, language: str) -> tuple[Optional[Path], list[str]]:
    logs: list[str] = []
    if not SUBLIMINAL_AVAILABLE or Language is None or scan_video is None or download_best_subtitles is None:
        return None, ["[subliminal] indisponível: instale subliminal e babelfish"]
    try:
        ensure_subliminal_region()
        output_dir.mkdir(parents=True, exist_ok=True)
        before = {p.resolve() for p in output_dir.glob(f"{video.stem}*.srt")}
        lang = Language.fromietf(language)
        video_obj = scan_video(str(video))
        subtitles = download_best_subtitles({video_obj}, {lang}, providers={"opensubtitles", "podnapisi"})
        found = subtitles.get(video_obj, [])
        if not found:
            return None, [f"[subliminal] nenhum resultado para {video.name}"]
        subliminal_save_subtitles(video_obj, found, directory=str(output_dir))
        candidates = [p for p in output_dir.glob(f"{video.stem}*.srt") if p.resolve() not in before]
        if not candidates:
            candidates = list(output_dir.glob(f"{video.stem}*.srt"))
        if not candidates:
            return None, ["[subliminal] legenda baixada, mas arquivo .srt não foi encontrado"]
        best = sorted(candidates, key=lambda p: (p.suffix.lower() != ".srt", len(p.name), -p.stat().st_mtime))[0]
        best = normalize_subtitle_to_utf8(best)
        return best, [f"[subliminal] legenda baixada: {best.name}"]
    except Exception as exc:
        return None, [f"[subliminal] falhou: {str(exc)[:140]}"]


def fetch_subtitle_from_providers(
    video: Path,
    output_dir: Path,
    language: str,
    on_progress: Optional[Callable[[str, int, str, str, str], None]] = None,
) -> tuple[Optional[Path], list[str], dict]:
    providers = load_providers()
    logs: list[str] = []
    ordered = sorted(providers.items(), key=lambda item: int(item[1].get("priority", 99)))

    def notify(stage: str, percent: int, message: str, provider_id: str = "", tone: str = "run") -> None:
        if on_progress is not None:
            on_progress(stage, percent, message, provider_id, tone)

    for provider_id, config in ordered:
        if not config.get("enabled") or not provider_configured(provider_id, config):
            continue
        if provider_id == "opensubtitles" and opensubtitles_downloads_exhausted(config):
            logs.append("[opensubtitles] pulado: limite diario de downloads atingido")
            notify("tentando outra fonte", 18, "[opensubtitles] limite diario atingido, tentando proxima fonte", provider_id, "run")
            continue
        cooldown = provider_cooldown_remaining(provider_id)
        if cooldown > 2.0:
            wait_text = f"{int(cooldown) + 1}s"
            logs.append(f"[{provider_id}] pulado: limite temporario, tente novamente em {wait_text}")
            notify("tentando outra fonte", 18, f"[{provider_id}] em cooldown ({wait_text}), tentando proxima fonte", provider_id, "run")
            continue
        if provider_id == "subliminal":
            notify("buscando legenda", 16, "[subliminal] tentando OpenSubtitles + Podnapisi", provider_id)
            path, provider_logs = fetch_subtitle_with_subliminal(video, output_dir, language)
            logs.extend(provider_logs)
            if path:
                notify("download", 38, provider_logs[-1] if provider_logs else "[subliminal] legenda baixada", provider_id)
                return path, logs, {"provider": provider_id, "match_source": "legacy", "compatible": False}
            notify("tentando outra fonte", 22, provider_logs[-1] if provider_logs else "[subliminal] falhou", provider_id, "run")
            continue
        try:
            notify("buscando legenda", 16, f"[{provider_id}] buscando no provedor", provider_id)
            matches = search_provider(video, language, provider_id, config)
            if not matches:
                logs.append(f"[{provider_id}] nenhum resultado para {video.name}")
                notify("tentando outra fonte", 22, f"[{provider_id}] nenhum resultado, tentando proxima fonte", provider_id, "run")
                continue
            logs.append(f"[{provider_id}] {len(matches)} resultado(s)")
            notify("download", 26, f"[{provider_id}] {len(matches)} resultado(s), tentando baixar", provider_id)
            last_error = ""
            for candidate in matches[:5]:
                try:
                    notify("download", 32, f"[{provider_id}] baixando: {candidate.get('name', 'sem nome')}", provider_id)
                    path = download_provider_subtitle(candidate, video, output_dir, language, config)
                    mark_provider_download(config, True, "")
                    providers[provider_id] = config
                    save_providers(providers)
                    logs.append(f"[{provider_id}] legenda baixada: {candidate['name']}")
                    match_source = str(candidate.get("match_source") or "name")
                    compatible = bool(candidate.get("compatible"))
                    source_note = " por hash" if compatible else ""
                    notify("download", 38, f"[{provider_id}] legenda baixada{source_note}: {candidate['name']}", provider_id)
                    return path, logs, {"provider": provider_id, "match_source": match_source, "compatible": compatible}
                except Exception as exc:
                    last_error = str(exc)
                    logs.append(f"[{provider_id}] download falhou ({candidate.get('name', 'sem nome')}): {last_error[:100]}")
                    notify("download falhou", 34, f"[{provider_id}] falhou: {last_error[:120]}", provider_id, "run")
            if last_error:
                mark_provider_download(config, False, last_error)
                providers[provider_id] = config
                save_providers(providers)
                logs.append(f"[{provider_id}] nenhum download funcionou: {last_error[:140]}")
                notify("tentando outra fonte", 36, f"[{provider_id}] nenhum download funcionou, tentando proxima fonte", provider_id, "run")
        except Exception as exc:
            logs.append(f"[{provider_id}] falhou: {str(exc)[:140]}")
            notify("tentando outra fonte", 22, f"[{provider_id}] falhou: {str(exc)[:120]}", provider_id, "run")
    return None, logs, {}


def summarize_provider_attempts(provider_logs: list[str]) -> str:
    provider_names = {
        "subdl": "SubDL",
        "subliminal": "Subliminal",
        "opensubtitles": "OpenSubtitles",
        "subsource": "SubSource",
    }
    provider_order: list[str] = []
    provider_status: dict[str, str] = {}

    for line in provider_logs:
        match = re.match(r"\[([^\]]+)\]\s*(.*)", str(line or ""))
        if not match:
            continue
        provider_id = match.group(1).strip().lower()
        message = match.group(2).strip()
        lower = message.lower()
        if provider_id not in provider_order:
            provider_order.append(provider_id)

        if "legenda baixada" in lower:
            provider_status[provider_id] = "baixou"
        elif "nenhum resultado" in lower:
            provider_status[provider_id] = "sem resultado"
        elif "429" in lower or "too many requests" in lower or "rate limit" in lower or "limite temporario" in lower or "limite diario" in lower or "limite atingido" in lower or "cooldown" in lower:
            provider_status[provider_id] = "limite atingido"
        elif "503" in lower or "service unavailable" in lower:
            provider_status[provider_id] = "indisponivel"
        elif "401" in lower or "403" in lower or "recusada" in lower or "acesso recusado" in lower:
            provider_status[provider_id] = "acesso recusado"
        elif "nenhum download funcionou" in lower or "download falhou" in lower or "falhou" in lower:
            provider_status[provider_id] = "falhou"
        elif "resultado(s)" in lower:
            provider_status.setdefault(provider_id, "resultado encontrado")
        else:
            provider_status.setdefault(provider_id, message[:70] or "tentado")

    parts = []
    for provider_id in provider_order:
        label = provider_names.get(provider_id, provider_id)
        parts.append(f"{label}: {provider_status.get(provider_id, 'tentado')}")
    return " | ".join(parts) if parts else "Nenhuma legenda encontrada para este arquivo no idioma escolhido."


def find_alass(explicit: Optional[str]) -> Optional[str]:
    if explicit and Path(explicit).exists():
        return explicit
    local_candidates = [
        RUNTIME_DIR / "alass" / "alass-cli.exe",
        RUNTIME_DIR / "alass" / "alass.exe",
        Path.cwd() / "bin" / "alass-cli.exe",
        Path.cwd() / "bin" / "alass.exe",
        Path.cwd().parent / "subtitle-sync-gui" / "bin" / "alass-cli.exe",
        Path.cwd().parent / "subtitle-sync-gui" / "bin" / "alass.exe",
        Path.cwd().parent / "subtitle-sync-gui" / "alass-windows64" / "bin" / "alass-cli.exe",
        Path.cwd().parent / "subtitle-sync-gui" / "alass-windows64" / "bin" / "alass.exe",
    ]
    for candidate in local_candidates:
        if candidate.exists():
            return str(candidate)
    return shutil.which("alass-cli.exe") or shutil.which("alass.exe")


def find_ffprobe() -> Optional[str]:
    local_candidates = [
        RUNTIME_DIR / "ffmpeg" / "ffprobe.exe",
        Path.cwd() / "ffmpeg" / "bin" / "ffprobe.exe",
        Path.cwd().parent / "subtitle-sync-gui" / "ffmpeg" / "bin" / "ffprobe.exe",
        Path.cwd().parent / "subtitle-sync-gui" / "bin" / "ffprobe.exe",
    ]
    for candidate in local_candidates:
        if candidate.exists():
            return str(candidate)
    return shutil.which("ffprobe")


def find_ffmpeg() -> Optional[str]:
    local_candidates = [
        RUNTIME_DIR / "ffmpeg" / "ffmpeg.exe",
        Path.cwd() / "ffmpeg" / "bin" / "ffmpeg.exe",
        Path.cwd().parent / "subtitle-sync-gui" / "ffmpeg" / "bin" / "ffmpeg.exe",
    ]
    for candidate in local_candidates:
        if candidate.exists():
            return str(candidate)
    return shutil.which("ffmpeg")


def runtime_alass_path() -> Optional[str]:
    for candidate in [RUNTIME_DIR / "alass" / "alass-cli.exe", RUNTIME_DIR / "alass" / "alass.exe"]:
        if candidate.exists():
            return str(candidate)
    return None


def runtime_ffmpeg_path() -> Optional[str]:
    candidate = RUNTIME_DIR / "ffmpeg" / "ffmpeg.exe"
    return str(candidate) if candidate.exists() else None


def runtime_ffprobe_path() -> Optional[str]:
    candidate = RUNTIME_DIR / "ffmpeg" / "ffprobe.exe"
    return str(candidate) if candidate.exists() else None


def tool_runs(path: Optional[str], args: list[str], timeout: int = 3) -> tuple[bool, str]:
    if not path:
        return False, "Arquivo não encontrado"
    try:
        proc = subprocess.run([path, *args], capture_output=True, text=True, timeout=timeout, check=False, creationflags=SUBPROCESS_FLAGS)
    except Exception as exc:
        return False, str(exc)
    output = (proc.stdout or proc.stderr or "").strip().splitlines()
    message = output[0] if output else f"exit {proc.returncode}"
    return proc.returncode == 0, message


def load_manifest() -> dict:
    if not MANIFEST_PATH.exists():
        return {}
    try:
        return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_manifest(data: dict) -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(data, ensure_ascii=True, indent=2), encoding="utf-8")


DEFAULT_PROVIDERS = {
    "subdl": {
        "enabled": True,
        "priority": 1,
        "api_key": "",
        "last_test_ok": None,
        "last_test_error": "",
        "last_download_ok": None,
        "last_download_error": "",
    },
    "subliminal": {
        "enabled": True,
        "priority": 2,
        "last_test_ok": None,
        "last_test_error": "",
        "last_download_ok": None,
        "last_download_error": "",
    },
    "opensubtitles": {
        "enabled": True,
        "priority": 3,
        "api_key": "",
        "username": "",
        "password": "",
        "token": "",
        "base_url": "api.opensubtitles.com",
        "last_test_ok": None,
        "last_test_error": "",
        "last_download_ok": None,
        "last_download_error": "",
    },
    "subsource": {
        "enabled": False,
        "priority": 4,
        "api_key": "",
        "last_test_ok": None,
        "last_test_error": "",
        "last_download_ok": None,
        "last_download_error": "",
    },
}


def load_providers() -> dict:
    if not PROVIDERS_PATH.exists():
        return json.loads(json.dumps(DEFAULT_PROVIDERS))
    try:
        stored = json.loads(PROVIDERS_PATH.read_text(encoding="utf-8"))
    except Exception:
        stored = {}
    merged = json.loads(json.dumps(DEFAULT_PROVIDERS))
    for key, value in stored.items():
        if key in merged and isinstance(value, dict):
            merged[key].update(value)
    return merged


def save_providers(data: dict) -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    PROVIDERS_PATH.write_text(json.dumps(data, ensure_ascii=True, indent=2), encoding="utf-8")


def masked(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "****"
    return f"{value[:4]}...{value[-4:]}"


def optional_int(value: object) -> Optional[int]:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except Exception:
        return None


def normalize_opensubtitles_account_info(info: dict) -> dict:
    allowed = optional_int(info.get("allowed_downloads"))
    count = optional_int(info.get("downloads_count") or info.get("download_count"))
    remaining = optional_int(info.get("remaining_downloads") or info.get("downloads_remaining"))
    if remaining is None and allowed is not None and count is not None:
        remaining = max(0, allowed - count)
    account_info = {
        "username": info.get("username") or info.get("user") or "",
        "allowed_downloads": allowed,
        "downloads_count": count,
        "downloads_remaining": remaining,
        "vip": info.get("vip") or info.get("is_vip"),
    }
    return {k: v for k, v in account_info.items() if v not in (None, "")}


def opensubtitles_downloads_exhausted(config: dict) -> bool:
    if config.get("last_download_ok") is False and is_transient_provider_error(config.get("last_download_error", "")):
        return False
    info = config.get("account_info") if isinstance(config.get("account_info"), dict) else {}
    remaining = optional_int(info.get("downloads_remaining"))
    if remaining is not None:
        return remaining <= 0
    allowed = optional_int(info.get("allowed_downloads"))
    count = optional_int(info.get("downloads_count") or info.get("download_count"))
    return allowed is not None and count is not None and count >= allowed


def public_providers() -> dict:
    providers = load_providers()
    result = {}
    for provider_id, config in providers.items():
        public = {k: v for k, v in config.items() if k not in {"api_key", "password", "token"}}
        public["has_api_key"] = bool(config.get("api_key"))
        public["api_key_masked"] = masked(str(config.get("api_key", "")))
        public["has_username"] = bool(config.get("username"))
        public["has_password"] = bool(config.get("password"))
        public["account_connected"] = bool(config.get("token"))
        public["account_info"] = (
            normalize_opensubtitles_account_info(config.get("account_info", {}))
            if provider_id == "opensubtitles" and isinstance(config.get("account_info"), dict)
            else config.get("account_info", {})
        )
        public["configured"] = provider_configured(provider_id, config)
        last_test_error = config.get("last_test_error", "")
        last_download_error = config.get("last_download_error", "")
        if provider_id == "opensubtitles" and is_transient_provider_error(last_test_error):
            public["last_test_ok"] = None
            public["last_test_error"] = ""
        else:
            public["last_test_ok"] = config.get("last_test_ok")
            public["last_test_error"] = last_test_error
        if provider_id == "opensubtitles" and is_transient_provider_error(last_download_error):
            public["last_download_ok"] = None
            public["last_download_error"] = ""
        else:
            public["last_download_ok"] = config.get("last_download_ok")
            public["last_download_error"] = last_download_error
        result[provider_id] = public
    return result


def provider_configured(provider_id: str, config: dict) -> bool:
    if provider_id == "subliminal":
        return SUBLIMINAL_AVAILABLE
    if provider_id in {"subdl", "subsource"}:
        return bool(config.get("api_key"))
    if provider_id == "opensubtitles":
        return bool(config.get("api_key"))
    return False


def provider_headers(provider_id: str, config: dict) -> dict:
    if provider_id == "subsource":
        return {"X-API-Key": str(config.get("api_key", ""))}
    if provider_id == "opensubtitles":
        headers = {"Api-Key": str(config.get("api_key", "")), "User-Agent": "Syncora/0.1.0"}
        if config.get("token"):
            headers["Authorization"] = f"Bearer {config['token']}"
        return headers
    return {}


def language_for_subsource(code: str) -> str:
    c = normalize_lang(code)
    mapping = {
        "pt-br": "brazilian_portuguese",
        "pt-pt": "portuguese",
        "pt": "portuguese",
        "en": "english",
        "es": "spanish",
    }
    return mapping.get(c, c.replace("-", "_"))


def subsource_error_message(exc: Exception) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        body_text = ""
        try:
            body_text = exc.read().decode("utf-8", errors="ignore")
        except Exception:
            body_text = ""
        detail = ""
        if body_text:
            try:
                payload = json.loads(body_text)
                err = str(payload.get("error") or "").strip()
                msg = str(payload.get("message") or "").strip()
                if err and msg and err.lower() != msg.lower():
                    detail = f"{err}: {msg}"
                else:
                    detail = msg or err
            except Exception:
                detail = body_text.strip()
        if not detail:
            detail = str(exc.reason or "").strip()
        return f"HTTP {exc.code}: {detail}" if detail else f"HTTP {exc.code}"
    return str(exc)


def subsource_request_json(path: str, config: dict, params: Optional[dict] = None, timeout: int = 30) -> dict:
    base = "https://api.subsource.net/api/v1"
    query = urllib.parse.urlencode(params or {})
    url = f"{base}{path}"
    if query:
        url = f"{url}?{query}"
    try:
        wait_provider_turn("subsource")
        data = request_json(url, timeout, provider_headers("subsource", config))
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            postpone_provider("subsource", retry_after_seconds(exc, 25.0))
        raise RuntimeError(subsource_error_message(exc)) from exc
    except Exception as exc:
        raise RuntimeError(subsource_error_message(exc)) from exc
    if not data.get("success", True):
        err = str(data.get("error") or "").strip()
        msg = str(data.get("message") or "").strip()
        detail = f"{err}: {msg}" if err and msg and err.lower() != msg.lower() else (msg or err)
        raise RuntimeError(detail or "Resposta invalida do SubSource")
    return data


def subsource_request_bytes(path: str, config: dict, timeout: int = 90) -> bytes:
    base = "https://api.subsource.net/api/v1"
    url = f"{base}{path}"
    try:
        wait_provider_turn("subsource")
        return request_bytes(url, timeout, provider_headers("subsource", config))
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            postpone_provider("subsource", retry_after_seconds(exc, 25.0))
        raise RuntimeError(subsource_error_message(exc)) from exc
    except Exception as exc:
        raise RuntimeError(subsource_error_message(exc)) from exc


def probe_subsource(config: dict) -> str:
    search_data = subsource_request_json(
        "/movies/search",
        config,
        {"searchType": "text", "q": "Inception", "limit": 5},
        timeout=20,
    )
    movies = search_data.get("data") or []
    if not isinstance(movies, list):
        movies = []
    if not movies:
        mark_provider_download(config, None, "Conexao OK, sem amostra para validar download")
        return "Conexao OK (sem amostra para validar download)"

    def movie_subcount(movie: dict) -> int:
        try:
            return int(movie.get("subtitleCount") or 0)
        except Exception:
            return 0

    probe_movie = sorted(movies, key=movie_subcount, reverse=True)[0]
    movie_id = probe_movie.get("movieId") or probe_movie.get("id") or probe_movie.get("_id")
    if not movie_id:
        mark_provider_download(config, None, "Conexao OK, sem movieId para validar download")
        return "Conexao OK (sem movieId para validar download)"

    subs_data = subsource_request_json(
        "/subtitles",
        config,
        {"movieId": int(movie_id), "language": "english", "limit": 1},
        timeout=20,
    )
    subtitles = subs_data.get("data") or []
    if not isinstance(subtitles, list):
        subtitles = []
    if not subtitles:
        subs_data = subsource_request_json(
            "/subtitles",
            config,
            {"movieId": int(movie_id), "limit": 1},
            timeout=20,
        )
        subtitles = subs_data.get("data") or []
        if not isinstance(subtitles, list):
            subtitles = []
    if not subtitles:
        mark_provider_download(config, None, "Conexao OK, sem amostra para validar download")
        return "Conexao OK (sem amostra para validar download)"

    subtitle_id = subtitles[0].get("subtitleId") or subtitles[0].get("id")
    if not subtitle_id:
        mark_provider_download(config, None, "Conexao OK, sem subtitleId para validar download")
        return "Conexao OK (sem subtitleId para validar download)"

    candidate = {
        "provider": "subsource",
        "id": str(subtitle_id),
        "download_url": str(subtitle_id),
        "name": "SubSource probe",
    }
    probe_video = Path("Inception.2010.1080p.BluRay.x264.mkv")
    with tempfile.TemporaryDirectory(prefix="subsource-test-") as tmp:
        download_provider_subtitle(candidate, probe_video, Path(tmp), "en", config)
    mark_provider_download(config, True, "")
    return "Conexao e download de teste OK"


def mark_provider_test(config: dict, ok: bool, error: str = "") -> None:
    config["last_test_ok"] = None if is_transient_provider_error(error) else ok
    config["last_test_error"] = "" if is_transient_provider_error(error) else error
    config["last_tested_at"] = datetime.now(timezone.utc).isoformat()


def mark_provider_download(config: dict, ok: Optional[bool], error: str = "") -> None:
    config["last_download_ok"] = None if is_transient_provider_error(error) else ok
    config["last_download_error"] = "" if is_transient_provider_error(error) else error
    config["last_download_at"] = datetime.now(timezone.utc).isoformat()


def is_transient_provider_error(error: object) -> bool:
    text = str(error or "").lower()
    return (
        "http 429" in text
        or "too many requests" in text
        or "rate limit" in text
        or "limite de requisicoes" in text
        or "limite temporario" in text
        or "http 503" in text
        or "service unavailable" in text
        or "servico indisponivel" in text
    )


def install_alass() -> dict:
    api_url = "https://api.github.com/repos/kaegi/alass/releases/latest"
    release = fetch_json(api_url, 30)
    tag = release.get("tag_name", "unknown")
    assets = release.get("assets", [])
    asset_url = None
    for asset in assets:
        name = str(asset.get("name", "")).lower()
        if "windows64" in name and name.endswith(".zip"):
            asset_url = asset.get("browser_download_url")
            break
    if not asset_url:
        raise RuntimeError("Asset Windows64 do ALASS não encontrado")
    with tempfile.NamedTemporaryFile(delete=False, suffix=".zip") as tmp:
        tmp_path = Path(tmp.name)
    tmp_path.write_bytes(download_bytes(asset_url, 180))
    out_dir = RUNTIME_DIR / "alass"
    out_dir.mkdir(parents=True, exist_ok=True)
    extracted = None
    with zipfile.ZipFile(tmp_path, "r") as zf:
        for name in zf.namelist():
            lower = name.lower()
            if lower.endswith("alass-cli.exe") or lower.endswith("alass.exe"):
                with zf.open(name) as src, open(out_dir / "alass-cli.exe", "wb") as dst:
                    shutil.copyfileobj(src, dst)
                extracted = out_dir / "alass-cli.exe"
                break
    tmp_path.unlink(missing_ok=True)
    if not extracted or not extracted.exists():
        raise RuntimeError("Não foi possível extrair alass-cli.exe")
    manifest = load_manifest()
    manifest["alass"] = {"version": tag, "path": str(extracted)}
    save_manifest(manifest)
    return manifest["alass"]


def install_ffmpeg() -> dict:
    api_url = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest"
    release = fetch_json(api_url, 30)
    tag = release.get("tag_name", "unknown")
    assets = release.get("assets", [])
    asset_url = None
    for asset in assets:
        name = str(asset.get("name", "")).lower()
        if "win64" in name and "lgpl-shared" in name and name.endswith(".zip"):
            asset_url = asset.get("browser_download_url")
            break
    if not asset_url:
        raise RuntimeError("Asset win64 do FFmpeg não encontrado")
    with tempfile.NamedTemporaryFile(delete=False, suffix=".zip") as tmp:
        tmp_path = Path(tmp.name)
    tmp_path.write_bytes(download_bytes(asset_url, 300))
    out_dir = RUNTIME_DIR / "ffmpeg"
    out_dir.mkdir(parents=True, exist_ok=True)
    ffmpeg_ok = False
    ffprobe_ok = False
    with zipfile.ZipFile(tmp_path, "r") as zf:
        for name in zf.namelist():
            lower = name.lower().replace("\\", "/")
            if "/bin/" not in lower:
                continue
            filename = Path(lower).name
            if lower.endswith(".exe") or lower.endswith(".dll"):
                with zf.open(name) as src, open(out_dir / filename, "wb") as dst:
                    shutil.copyfileobj(src, dst)
            if filename == "ffmpeg.exe":
                ffmpeg_ok = True
            if filename == "ffprobe.exe":
                ffprobe_ok = True
    tmp_path.unlink(missing_ok=True)
    if not ffmpeg_ok or not ffprobe_ok:
        raise RuntimeError("Não foi possível extrair ffmpeg/ffprobe")
    manifest = load_manifest()
    manifest["ffmpeg"] = {"version": tag, "path": str(out_dir / "ffmpeg.exe")}
    save_manifest(manifest)
    return manifest["ffmpeg"]


def normalize_lang(code: str) -> str:
    c = (code or "").strip().lower().replace("_", "-")
    mapping = {
        "pt-br": "pt-br",
        "pt-pt": "pt-pt",
        "pt": "pt",
        "por": "pt",
        "pob": "pt-br",
        "en": "en",
        "eng": "en",
        "es": "es",
        "spa": "es",
    }
    return mapping.get(c, c)


def classify_pt_variant(lang: str, title: str) -> str:
    ll = (lang or "").lower()
    tt = (title or "").lower()
    if ll in {"pt-br", "pob"} or "brazil" in tt or "brasil" in tt or " btm br" in tt:
        return "pt-br"
    if ll in {"pt-pt"} or "portugal" in tt or " btm pt" in tt:
        return "pt-pt"
    if ll in {"pt", "por"} or "portugu" in tt:
        return "pt-amb"
    return ""


def has_embedded_subtitle(video: Path, wanted_lang: str) -> bool:
    ffprobe = find_ffprobe()
    if not ffprobe:
        return False
    cmd = [
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "s",
        "-show_entries",
        "stream=index:stream_tags=language,title",
        "-of",
        "json",
        str(video),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=60, creationflags=SUBPROCESS_FLAGS)
        if result.returncode != 0:
            return False
        data = json.loads(result.stdout or "{}")
        streams = data.get("streams", [])
        if not streams:
            return False

        want = normalize_lang(wanted_lang)
        for s in streams:
            tags = s.get("tags", {})
            lang = normalize_lang(str(tags.get("language", "")))
            title = str(tags.get("title", ""))
            if want in {"pt-br", "pt-pt", "pt"}:
                pt = classify_pt_variant(lang, title)
                if want == "pt" and pt in {"pt-br", "pt-pt", "pt-amb"}:
                    return True
                if want == "pt-br" and pt == "pt-br":
                    return True
                if want == "pt-pt" and pt == "pt-pt":
                    return True
                # Muitos releases marcam apenas "por"/"pt" sem diferenciar BR/PT.
                # Nesse caso tratamos como match para o idioma portugues escolhido.
                if want in {"pt-br", "pt-pt"} and pt == "pt-amb":
                    return True
            elif lang == want:
                return True
        return False
    except Exception:
        return False


def lang_to_ffmpeg(code: str) -> str:
    normalized = normalize_lang(code)
    if normalized.startswith("pt"):
        return "por"
    if normalized == "en":
        return "eng"
    if normalized == "es":
        return "spa"
    return normalized[:3] if normalized else "und"


def embed_subtitle(
    ffmpeg: str,
    video_path: Path,
    subtitle_path: Path,
    output_dir: Path,
    update_original: bool,
    keep_bak: bool,
    subtitle_default: bool,
    subtitle_track: str,
    language: str,
    timeout: int,
) -> Path:
    if not video_path.exists():
        raise RuntimeError("Vídeo não encontrado")
    if not subtitle_path.exists():
        raise RuntimeError("Legenda sincronizada não encontrada")

    output_dir.mkdir(parents=True, exist_ok=True)
    ext = video_path.suffix.lower()
    mux_ext = ".mp4" if ext in {".mp4", ".m4v", ".mov"} else ".mkv"
    temp_output = output_dir / f"{video_path.stem}.synced{mux_ext}"
    if update_original:
        temp_output = video_path.with_name(f"{video_path.stem}.synclegendas.tmp{mux_ext}")

    subtitle_codec = "mov_text" if mux_ext == ".mp4" else "srt"
    disposition = "default" if subtitle_default else "0"
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(video_path),
        "-i",
        str(subtitle_path),
        "-map",
        "0",
        "-map",
        "1:0",
        "-c",
        "copy",
        "-c:s",
        subtitle_codec,
        "-metadata:s:s:0",
        f"language={lang_to_ffmpeg(language)}",
        "-metadata:s:s:0",
        f"title={subtitle_track or 'Portuguese (Sync)'}",
        "-disposition:s:0",
        disposition,
        str(temp_output),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=timeout, creationflags=SUBPROCESS_FLAGS)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "Erro desconhecido no FFmpeg").strip()[:220])

    if not update_original:
        return temp_output

    backup = video_path.with_suffix(video_path.suffix + ".bak")
    if keep_bak and not backup.exists():
        shutil.copy2(video_path, backup)
    if temp_output.suffix.lower() == video_path.suffix.lower():
        temp_output.replace(video_path)
        return video_path

    final_path = video_path.with_suffix(temp_output.suffix)
    if final_path.exists() and final_path != video_path:
        final_path.unlink()
    temp_output.replace(final_path)
    if keep_bak:
        video_path.unlink(missing_ok=True)
    return final_path



class ScanRequest(BaseModel):
    source_dir: str
    output_dir: str
    preserve_subfolders: bool = True
    language: str = "pt-BR"
    ignore_embedded_subtitles: bool = False
    files: Optional[list[str]] = None


class SyncRequest(BaseModel):
    source_dir: str
    output_dir: str
    alass_path: Optional[str] = None
    preserve_subfolders: bool = True
    force_resync: bool = False
    force_download: bool = False
    auto_download_missing_subtitles: bool = True
    language: str = "pt-BR"
    ignore_embedded_subtitles: bool = False
    targets: Optional[list[str]] = None
    embed_softsub: bool = False
    update_original: bool = False
    keep_bak: bool = True
    subtitle_default: bool = True
    subtitle_track: str = "Portuguese (Sync)"
    timeout_seconds: int = 900
    retries: int = 1


class DownloadMissingRequest(BaseModel):
    source_dir: str
    output_dir: str
    preserve_subfolders: bool = True
    force_download: bool = False
    language: str = "pt-BR"
    ignore_embedded_subtitles: bool = False
    targets: Optional[list[str]] = None


app = FastAPI(title="Syncora Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.get("/deps/status")
def deps_status() -> dict:
    manifest = load_manifest()
    alass_path = runtime_alass_path()
    ffmpeg_path = runtime_ffmpeg_path()
    ffprobe_path = runtime_ffprobe_path()
    alass_ok, alass_message = tool_runs(alass_path, ["--version"])
    ffmpeg_ok, ffmpeg_message = tool_runs(ffmpeg_path, ["-version"])
    ffprobe_ok, ffprobe_message = tool_runs(ffprobe_path, ["-version"])
    return {
        "ok": True,
        "alass": {"found": alass_ok, "path": alass_path, "message": alass_message, **manifest.get("alass", {})},
        "ffmpeg": {"found": ffmpeg_ok, "path": ffmpeg_path, "message": ffmpeg_message, **manifest.get("ffmpeg", {})},
        "ffprobe": {"found": ffprobe_ok, "path": ffprobe_path, "message": ffprobe_message},
    }


class DepsInstallRequest(BaseModel):
    target: str = "all"  # all | alass | ffmpeg


class OpenPathRequest(BaseModel):
    path: str


class ProviderUpdateRequest(BaseModel):
    provider_id: str
    enabled: bool = True
    priority: int = 1
    api_key: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None


class ProviderTestRequest(BaseModel):
    provider_id: str


class SubtitleSearchRequest(BaseModel):
    video_name: str
    language: str = "pt-BR"


class SubtitleDownloadRequest(BaseModel):
    provider_id: str
    subtitle_id: str
    video_name: str
    output_dir: str
    language: str = "pt-BR"


@app.post("/deps/install")
def deps_install(req: DepsInstallRequest) -> dict:
    result: dict = {"ok": True, "installed": {}}
    try:
        if req.target in {"all", "alass"}:
            result["installed"]["alass"] = install_alass()
        if req.target in {"all", "ffmpeg"}:
            result["installed"]["ffmpeg"] = install_ffmpeg()
    except Exception as exc:
        return {"ok": False, "error": str(exc), "installed": result["installed"]}
    return result


@app.get("/providers")
def providers_get() -> dict:
    return {"ok": True, "providers": public_providers()}


@app.post("/providers")
def providers_update(req: ProviderUpdateRequest) -> dict:
    providers = load_providers()
    if req.provider_id not in providers:
        return {"ok": False, "error": "Provedor desconhecido"}
    config = providers[req.provider_id]
    config["enabled"] = req.enabled
    config["priority"] = req.priority
    if req.api_key is not None:
        new_api_key = req.api_key.strip()
        if new_api_key != config.get("api_key"):
            config["token"] = ""
            config["base_url"] = "api.opensubtitles.com"
            config["account_info"] = {}
            config["last_test_ok"] = None
            config["last_test_error"] = ""
            config["last_download_ok"] = None
            config["last_download_error"] = ""
        config["api_key"] = new_api_key
    if req.username is not None:
        new_username = req.username.strip()
        if new_username != config.get("username"):
            config["token"] = ""
            config["account_info"] = {}
            config["last_test_ok"] = None
            config["last_test_error"] = ""
            config["last_download_ok"] = None
            config["last_download_error"] = ""
        config["username"] = new_username
        if not new_username:
            config["password"] = ""
    if req.password is not None:
        config["password"] = req.password
        config["token"] = ""
        config["account_info"] = {}
        config["last_test_ok"] = None
        config["last_test_error"] = ""
        config["last_download_ok"] = None
        config["last_download_error"] = ""
    save_providers(providers)
    return {"ok": True, "providers": public_providers()}


@app.post("/providers/test-legacy")
def providers_test_legacy(req: ProviderTestRequest) -> dict:
    providers = load_providers()
    config = providers.get(req.provider_id)
    if not config:
        return {"ok": False, "error": "Provedor desconhecido"}
    if not provider_configured(req.provider_id, config):
        mark_provider_test(config, False, "Configure a API key primeiro")
        save_providers(providers)
        return {"ok": False, "error": "Configure a API key primeiro", "providers": public_providers()}
    try:
        if req.provider_id == "subliminal":
            ensure_subliminal_region()
            mark_provider_download(config, True, "Usa fluxo do Subliminal")
        elif req.provider_id == "subdl":
            subdl_request_json({"api_key": config["api_key"], "film_name": "Inception", "languages": "EN", "subs_per_page": 1}, 20)
        elif req.provider_id == "subsource":
            probe_subsource(config)
        elif req.provider_id == "opensubtitles":
            opensubtitles_login_if_needed(config)
            providers[req.provider_id] = config
            save_providers(providers)
        else:
            return {"ok": False, "error": "Provedor desconhecido"}
        mark_provider_test(config, True, "")
        providers[req.provider_id] = config
        save_providers(providers)
        return {"ok": True, "message": "Conexão OK", "providers": public_providers()}
    except Exception as exc:
        if req.provider_id in {"opensubtitles", "subsource", "subdl"}:
            mark_provider_download(config, False, str(exc))
        mark_provider_test(config, False, str(exc))
        providers[req.provider_id] = config
        save_providers(providers)
        return {"ok": False, "error": str(exc), "providers": public_providers()}


@app.post("/providers/test")
def providers_test(req: ProviderTestRequest) -> dict:
    providers = load_providers()
    config = providers.get(req.provider_id)
    if not config:
        return {"ok": False, "error": "Provedor desconhecido"}
    if not provider_configured(req.provider_id, config):
        mark_provider_test(config, False, "Configure a API key primeiro")
        save_providers(providers)
        return {"ok": False, "error": "Configure a API key primeiro", "providers": public_providers()}
    try:
        message = "Conexao OK"
        if req.provider_id == "subliminal":
            ensure_subliminal_region()
            mark_provider_download(config, True, "Usa fluxo do Subliminal")
        elif req.provider_id == "subdl":
            subdl_request_json({"api_key": config["api_key"], "film_name": "Inception", "languages": "EN", "subs_per_page": 1}, 20)
            mark_provider_download(config, None, "Conexao validada. Download sera validado no primeiro uso.")
            message = "Conexao OK (download sera validado no primeiro uso)"
        elif req.provider_id == "subsource":
            message = probe_subsource(config)
        elif req.provider_id == "opensubtitles":
            opensubtitles_login_if_needed(config)
            account_info = opensubtitles_user_info(config)
            probe_video = Path("The.Knick.S02E10.1080p.Bluray.x265-HiQVE.mkv")
            matches = search_opensubtitles(probe_video, "pt-BR", config)
            if not matches:
                matches = search_opensubtitles(probe_video, "en", config)
            search_ok = bool(matches)
            mark_provider_download(config, None, "Conexao validada. Download sera validado no primeiro uso.")
            if account_info.get("downloads_remaining") is not None:
                prefix = "Conta e busca OK" if search_ok else "Conta OK"
                message = f"{prefix} ({account_info.get('downloads_remaining')} downloads restantes)"
            elif account_info:
                message = "Conta e busca OK" if search_ok else "Conta OK"
            elif search_ok:
                message = "API key e busca OK"
            else:
                message = "API key OK"
        else:
            return {"ok": False, "error": "Provedor desconhecido"}
        mark_provider_test(config, True, "")
        providers[req.provider_id] = config
        save_providers(providers)
        return {"ok": True, "message": message, "providers": public_providers()}
    except Exception as exc:
        if req.provider_id in {"opensubtitles", "subsource", "subdl"}:
            mark_provider_download(config, False, str(exc))
        mark_provider_test(config, False, str(exc))
        providers[req.provider_id] = config
        save_providers(providers)
        return {"ok": False, "error": str(exc), "providers": public_providers()}


@app.post("/subtitles/search")
def subtitles_search(req: SubtitleSearchRequest) -> dict:
    video = Path(req.video_name)
    providers = load_providers()
    matches = []
    logs = []
    for provider_id, config in sorted(providers.items(), key=lambda item: int(item[1].get("priority", 99))):
        if not config.get("enabled") or not provider_configured(provider_id, config):
            continue
        try:
            provider_matches = search_provider(video, req.language, provider_id, config)
            matches.extend(provider_matches)
            logs.append(f"[{provider_id}] {len(provider_matches)} resultado(s)")
        except Exception as exc:
            logs.append(f"[{provider_id}] falhou: {str(exc)[:140]}")
    return {"ok": True, "matches": sorted(matches, key=lambda x: x.get("score", 0), reverse=True), "logs": logs}


@app.post("/subtitles/download")
def subtitles_download(req: SubtitleDownloadRequest) -> dict:
    providers = load_providers()
    config = providers.get(req.provider_id)
    if not config:
        return {"ok": False, "error": "Provedor desconhecido"}
    if not provider_configured(req.provider_id, config):
        return {"ok": False, "error": "Provedor não configurado"}
    download_ref = req.subtitle_id
    if req.provider_id == "subdl":
        download_ref = normalize_subdl_download_url(req.subtitle_id)
    candidate = {"provider": req.provider_id, "id": req.subtitle_id, "download_url": download_ref, "name": req.subtitle_id}
    try:
        path = download_provider_subtitle(candidate, Path(req.video_name), Path(req.output_dir), req.language, config)
        mark_provider_download(config, True, "")
        providers[req.provider_id] = config
        save_providers(providers)
        return {"ok": True, "path": str(path), "name": path.name}
    except Exception as exc:
        mark_provider_download(config, False, str(exc))
        providers[req.provider_id] = config
        save_providers(providers)
        return {"ok": False, "error": str(exc)}


def run_download_missing_core(
    req: DownloadMissingRequest,
    on_event: Optional[Callable[[str, dict], None]] = None,
    before_row: Optional[Callable[[dict, int, int], bool]] = None,
) -> dict:
    def emit(event_type: str, payload: Optional[dict] = None) -> None:
        if on_event is None:
            return
        on_event(event_type, payload or {})

    scan_result = scan(
        ScanRequest(
            source_dir=req.source_dir,
            output_dir=req.output_dir,
            preserve_subfolders=req.preserve_subfolders,
            language=req.language,
            ignore_embedded_subtitles=req.ignore_embedded_subtitles,
            files=req.targets,
        )
    )
    if not scan_result.get("ok"):
        return scan_result

    rows = scan_result.get("rows", [])
    logs: list[str] = []
    ok_count = 0
    fail_count = 0
    skip_count = 0

    total = len(rows)
    processed = 0
    emit("job_ready", {"total": total, "rows": rows})

    for index, row in enumerate(rows, start=1):
        if before_row is not None and before_row(row, index, total) is False:
            logs.append("[CANCELADO] Fila cancelada pelo usuário")
            break

        row_video_full = str(row.get("video_full", ""))
        row_video_name = str(row.get("video", ""))

        def emit_row(stage: str, percent: int, tone: str = "run") -> None:
            emit(
                "row_progress",
                {
                    "index": index,
                    "total": total,
                    "video_full": row_video_full,
                    "video": row_video_name,
                    "status": row.get("status"),
                    "stage": stage,
                    "percent": max(0, min(100, int(percent))),
                    "tone": tone,
                    "detail": row.get("detail", ""),
                    "subdetail": row.get("subdetail", ""),
                },
            )

        def emit_provider_progress(stage: str, percent: int, message: str, provider_id: str, tone: str = "run") -> None:
            row["detail"] = stage
            row["subdetail"] = message
            emit_row(stage, percent, tone)

        emit_row("preparando", 2, "run")
        video_path = Path(str(row.get("video_full", "")))
        output_full = str(row.get("output_full", ""))
        output_dir = Path(output_full).parent if output_full else Path(req.output_dir)
        has_subtitle = bool(row.get("subtitle_full"))

        if has_subtitle and not req.force_download:
            row["status"] = "OK"
            row["detail"] = "Legenda local encontrada"
            row["subdetail"] = "Nenhum download necessario"
            ok_count += 1
            processed += 1
            emit_row("finalizado", 100, "ok")
            emit("row_result", {"index": index, "total": total, "done": processed, "row": row})
            emit("job_progress", {"done": processed, "total": total})
            continue

        if row.get("status") == "PULADO" and "embutida" in str(row.get("detail", "")).lower() and not req.force_download:
            skip_count += 1
            processed += 1
            emit_row("pulado", 100, "idle")
            emit("row_result", {"index": index, "total": total, "done": processed, "row": row})
            emit("job_progress", {"done": processed, "total": total})
            continue

        if not video_path.is_file():
            row["status"] = "FALHOU"
            row["detail"] = "Arquivo de video nao encontrado"
            fail_count += 1
            processed += 1
            emit_row("falhou", 0, "fail")
            emit("row_result", {"index": index, "total": total, "done": processed, "row": row})
            emit("job_progress", {"done": processed, "total": total})
            continue

        emit_row("buscando legenda", 12, "run")
        downloaded, provider_logs, provider_meta = fetch_subtitle_from_providers(
            video_path,
            output_dir,
            req.language,
            on_progress=emit_provider_progress,
        )
        logs.extend(provider_logs)
        if downloaded:
            row["status"] = "OK"
            row["subtitle"] = downloaded.name
            row["subtitle_full"] = str(downloaded)
            source_note = "hash compatível" if provider_meta.get("compatible") else "provedor"
            row["subtitleMeta"] = f"Baixada de {source_note} ({downloaded.suffix.lower().lstrip('.')})"
            row["detail"] = "Legenda baixada"
            row["subdetail"] = downloaded.name
            ok_count += 1
            processed += 1
            emit_row("finalizado", 100, "ok")
            emit("row_result", {"index": index, "total": total, "done": processed, "row": row})
            emit("job_progress", {"done": processed, "total": total})
        else:
            row["status"] = "SEM_LEGENDA"
            row["detail"] = "Sem legenda"
            row["subdetail"] = summarize_provider_attempts(provider_logs)
            fail_count += 1
            processed += 1
            emit_row("sem legenda", 0, "fail")
            emit("row_result", {"index": index, "total": total, "done": processed, "row": row})
            emit("job_progress", {"done": processed, "total": total})

    return {
        "ok": True,
        "rows": rows,
        "summary": {"total": len(rows), "ok": ok_count, "fail": fail_count, "skip": skip_count},
        "logs": logs,
    }


@app.post("/subtitles/download-missing")
def subtitles_download_missing(req: DownloadMissingRequest) -> dict:
    return run_download_missing_core(req)


def run_download_missing_job(job_id: str, req: DownloadMissingRequest) -> None:
    job = get_sync_job(job_id)
    if job is None:
        return
    with SYNC_JOBS_LOCK:
        job["status"] = "running"
        job["pause_state"] = "running"
        job["updated_at"] = utc_now()
    sync_job_event(job, "job_started", {"job_id": job_id, "mode": "download"})

    def wait_if_paused(row: dict, index: int, total: int) -> bool:
        pause_announced = False
        while True:
            with SYNC_JOBS_LOCK:
                cancel_requested = bool(job.get("cancel_requested", False))
                paused = bool(job.get("paused", False))
            if cancel_requested:
                sync_job_event(job, "job_cancelled", {"job_id": job_id, "mode": "download", "index": index, "total": total})
                return False
            if not paused:
                if pause_announced:
                    with SYNC_JOBS_LOCK:
                        job["pause_state"] = "running"
                        job["updated_at"] = utc_now()
                    sync_job_event(job, "job_resumed", {"job_id": job_id})
                return True
            if not pause_announced:
                with SYNC_JOBS_LOCK:
                    job["pause_state"] = "paused"
                    job["updated_at"] = utc_now()
                sync_job_event(job, "job_paused", {"job_id": job_id})
                sync_job_event(
                    job,
                    "row_progress",
                    {
                        "index": index,
                        "total": total,
                        "video_full": str(row.get("video_full", "")),
                        "video": str(row.get("video", "")),
                        "status": row.get("status"),
                        "stage": "pausado",
                        "percent": 0,
                        "tone": "idle",
                        "detail": "Fila pausada",
                        "subdetail": "Aguardando continuar para iniciar este arquivo",
                    },
                )
                pause_announced = True
            time.sleep(0.5)

    try:
        result = run_download_missing_core(
            req,
            on_event=lambda event_type, payload: sync_job_event(job, event_type, payload),
            before_row=wait_if_paused,
        )
        with SYNC_JOBS_LOCK:
            cancelled = bool(job.get("cancel_requested", False))
            job["status"] = "cancelled" if cancelled else "done"
            job["updated_at"] = utc_now()
            job["result"] = result
            job["rows"] = result.get("rows", [])
            job["logs"] = result.get("logs", [])
            job["summary"] = result.get("summary", {})
        sync_job_event(
            job,
            "job_finished",
            {
                "job_id": job_id,
                "mode": "download",
                "cancelled": cancelled,
                "summary": result.get("summary", {}),
                "rows": result.get("rows", []),
                "logs": result.get("logs", []),
            },
        )
    except Exception as exc:
        with SYNC_JOBS_LOCK:
            job["status"] = "failed"
            job["updated_at"] = utc_now()
            job["error"] = str(exc)
        sync_job_event(job, "job_failed", {"job_id": job_id, "mode": "download", "error": str(exc)})


@app.post("/subtitles/download-missing/start")
def subtitles_download_missing_start(req: DownloadMissingRequest) -> dict:
    remove_old_sync_jobs()
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "status": "queued",
        "created_at": utc_now(),
        "updated_at": utc_now(),
        "events": [],
        "queue": queue.Queue(),
        "next_seq": 1,
        "error": "",
        "result": None,
        "rows": [],
        "logs": [],
        "summary": {},
        "paused": False,
        "pause_state": "running",
        "cancel_requested": False,
        "mode": "download",
    }
    with SYNC_JOBS_LOCK:
        SYNC_JOBS[job_id] = job
    thread = threading.Thread(target=run_download_missing_job, args=(job_id, req), daemon=True)
    thread.start()
    return {"ok": True, "job_id": job_id}


@app.post("/open-path")
def open_path(req: OpenPathRequest) -> dict:
    target = Path(req.path)
    if target.is_file():
        target = target.parent
    if not target.exists():
        return {"ok": False, "error": "Caminho não existe"}
    subprocess.Popen(["explorer", str(target)])
    return {"ok": True}


@app.post("/scan")
def scan(req: ScanRequest) -> dict:
    source = Path(req.source_dir)
    out = Path(req.output_dir)
    requested_files = [Path(path) for path in (req.files or []) if str(path).strip()]
    if not source.exists() and requested_files:
        existing_parents = [path.parent for path in requested_files if path.is_file()]
        if existing_parents:
            source = existing_parents[0]
    if not source.exists():
        return {"ok": False, "error": "Pasta origem não existe"}

    try:
        source_resolved = source.resolve()
        out_resolved = out.resolve()
    except Exception:
        source_resolved = source
        out_resolved = out

    output_inside_source = False
    try:
        output_inside_source = out_resolved.is_relative_to(source_resolved)
    except Exception:
        output_inside_source = str(out_resolved).lower().startswith(str(source_resolved).lower())
    same_dir = str(out_resolved).lower() == str(source_resolved).lower()
    exclude_output_tree = output_inside_source and not same_dir

    def is_valid_video(path: Path) -> bool:
        suffix = path.suffix.lower()
        name = path.name.lower()
        stem = path.stem.lower()
        if suffix not in VIDEO_EXTS:
            return False
        if ".synclegendas.tmp" in name or stem.endswith(".synclegendas.tmp"):
            return False
        # Blindagem extra: ignora nomes que parecem legenda renomeada.
        if any(name.endswith(ext) for ext in SUB_EXTS):
            return False
        if any(stem.endswith(ext.replace(".", "")) for ext in SUB_EXTS):
            return False
        return True

    videos: list[Path] = []
    if requested_files:
        seen_videos: set[str] = set()
        for p in requested_files:
            if not p.is_file() or not is_valid_video(p):
                continue
            key = str(p.resolve()).lower()
            if key in seen_videos:
                continue
            seen_videos.add(key)
            videos.append(p)
    else:
        for p in source.rglob("*"):
            if not p.is_file():
                continue
            if exclude_output_tree:
                try:
                    if p.resolve().is_relative_to(out_resolved):
                        continue
                except Exception:
                    if str(p).lower().startswith(str(out_resolved).lower()):
                        continue
            if not is_valid_video(p):
                continue
            videos.append(p)

    subtitles: list[Path] = []
    if requested_files:
        subtitle_roots = {video.parent for video in videos}
        for root in subtitle_roots:
            if not root.exists():
                continue
            for p in root.iterdir():
                if p.is_file() and p.suffix.lower() in SUB_EXTS:
                    subtitles.append(p)
    else:
        for p in source.rglob("*"):
            if not p.is_file():
                continue
            if exclude_output_tree:
                try:
                    if p.resolve().is_relative_to(out_resolved):
                        continue
                except Exception:
                    if str(p).lower().startswith(str(out_resolved).lower()):
                        continue
            if p.suffix.lower() in SUB_EXTS:
                subtitles.append(p)
    subtitle_map: dict[str, Path] = {normalize_stem(s.stem): s for s in subtitles}

    rows = []
    for video in videos:
        sub = subtitle_map.get(normalize_stem(video.stem))
        if req.preserve_subfolders:
            try:
                relative = video.parent.relative_to(source)
            except ValueError:
                relative = Path()
            out_dir = out / relative
        else:
            out_dir = out
        out_dir.mkdir(parents=True, exist_ok=True)
        synced = out_dir / f"{video.stem}.synced.srt"

        embedded_match = (not req.ignore_embedded_subtitles) and has_embedded_subtitle(video, req.language)

        if embedded_match:
            status = "PULADO"
            detail = "Legenda embutida detectada"
            subtitle_meta = "Idioma alvo detectado nas trilhas embutidas"
        elif sub:
            status = "PENDENTE"
            detail = "Pronto para sincronizar"
            subtitle_meta = ""
        else:
            status = "SEM_LEGENDA"
            detail = "Sem legenda"
            subtitle_meta = "Legenda não encontrada"

        rows.append(
            {
                "status": status,
                "video": video.name,
                "path": str(video.parent) + "\\",
                "subtitle": sub.name if sub else "—",
                "subtitleMeta": subtitle_meta,
                "output": synced.name,
                "outputPath": str(synced.parent) + "\\",
                "detail": detail,
                "subdetail": "",
                "video_full": str(video),
                "subtitle_full": str(sub) if sub else "",
                "output_full": str(synced),
            }
        )

    return {"ok": True, "rows": rows}


def run_sync_core(
    req: SyncRequest,
    on_event: Optional[Callable[[str, dict], None]] = None,
    before_row: Optional[Callable[[dict, int, int], bool]] = None,
) -> dict:
    def emit(event_type: str, payload: Optional[dict] = None) -> None:
        if on_event is None:
            return
        on_event(event_type, payload or {})

    scan_result = scan(
        ScanRequest(
            source_dir=req.source_dir,
            output_dir=req.output_dir,
            preserve_subfolders=req.preserve_subfolders,
            language=req.language,
            ignore_embedded_subtitles=req.ignore_embedded_subtitles,
            files=req.targets,
        )
    )
    if not scan_result.get("ok"):
        return scan_result

    alass = find_alass(req.alass_path)
    if not alass:
        return {"ok": False, "error": "ALASS não encontrado"}
    ffmpeg = find_ffmpeg()
    if req.embed_softsub and not ffmpeg:
        return {"ok": False, "error": "FFmpeg não encontrado para embutir softsub"}

    rows = scan_result["rows"]
    if req.targets:
        target_set = {str(t).lower() for t in req.targets}
        rows = [r for r in rows if str(r.get("video_full", "")).lower() in target_set]
    logs: list[str] = []
    ok_count = 0
    fail_count = 0
    processed = 0
    total = len(rows)

    emit("job_ready", {"total": total, "rows": rows})

    for index, row in enumerate(rows, start=1):
        if before_row is not None and before_row(row, index, total) is False:
            logs.append("[CANCELADO] Fila cancelada pelo usuário")
            break
        row_video_full = str(row.get("video_full", ""))
        row_video_name = str(row.get("video", ""))

        def emit_row(stage: str, percent: int, tone: str = "run") -> None:
            emit(
                "row_progress",
                {
                    "index": index,
                    "total": total,
                    "video_full": row_video_full,
                    "video": row_video_name,
                    "status": row.get("status"),
                    "stage": stage,
                    "percent": max(0, min(100, int(percent))),
                    "tone": tone,
                    "detail": row.get("detail", ""),
                    "subdetail": row.get("subdetail", ""),
                },
            )

        def emit_provider_progress(stage: str, percent: int, message: str, provider_id: str, tone: str = "run") -> None:
            row["detail"] = stage
            row["subdetail"] = message
            emit_row(stage, percent, tone)

        emit_row("preparando", 2, "run")
        sub = row["subtitle_full"]
        video_path = Path(row["video_full"])
        row_output_dir = Path(row["output_full"]).parent
        if req.force_download or (req.auto_download_missing_subtitles and not sub):
            emit_row("buscando legenda", 12, "run")
            downloaded, provider_logs, provider_meta = fetch_subtitle_from_providers(
                video_path,
                row_output_dir,
                req.language,
                on_progress=emit_provider_progress,
            )
            logs.extend(provider_logs)
            if provider_logs:
                if any("download falhou" in line or "nenhum download funcionou" in line for line in provider_logs):
                    row["detail"] = "Download da legenda falhou"
                    row["subdetail"] = summarize_provider_attempts(provider_logs)
                elif any("resultado(s)" in line for line in provider_logs):
                    row["detail"] = "Legenda encontrada"
                    row["subdetail"] = "Tentando baixar dos provedores"
                else:
                    row["subdetail"] = summarize_provider_attempts(provider_logs)
            if downloaded:
                sub = str(downloaded)
                row["subtitle"] = downloaded.name
                row["subtitle_full"] = str(downloaded)
                source_note = "hash compatível" if provider_meta.get("compatible") else "provedor"
                row["subtitleMeta"] = f"Baixada de {source_note} ({downloaded.suffix.lower().lstrip('.')})"
                emit_row("download", 36, "run")
                if provider_meta.get("compatible") and not req.force_resync:
                    out_path = Path(row["output_full"])
                    out_path.parent.mkdir(parents=True, exist_ok=True)
                    sub_path = normalize_subtitle_to_utf8(downloaded)
                    if sub_path.resolve() != out_path.resolve():
                        shutil.copy2(sub_path, out_path)
                    row["subtitle"] = sub_path.name
                    row["subtitle_full"] = str(sub_path)
                    row["output"] = out_path.name
                    row["outputPath"] = str(out_path.parent) + "\\"
                    if req.embed_softsub:
                        ffmpeg = find_ffmpeg()
                        if not ffmpeg:
                            row["status"] = "FALHOU"
                            row["detail"] = "FFmpeg não encontrado"
                            row["subdetail"] = "Baixe as dependências para embutir softsub"
                            fail_count += 1
                            logs.append(f"[FALHOU] {row['video']}: FFmpeg não encontrado")
                            emit_row("falhou no ffmpeg", 95, "fail")
                        else:
                            emit_row("embutindo softsub", 92, "run")
                            try:
                                muxed_path = embed_subtitle(
                                    ffmpeg=ffmpeg,
                                    video_path=Path(row["video_full"]),
                                    subtitle_path=out_path,
                                    output_dir=out_path.parent,
                                    update_original=req.update_original,
                                    keep_bak=True,
                                    subtitle_default=req.subtitle_default,
                                    subtitle_track=req.subtitle_track,
                                    language=req.language,
                                    timeout=max(30, int(req.timeout_seconds or 900)),
                                )
                                row["output"] = muxed_path.name
                                row["outputPath"] = str(muxed_path.parent) + "\\"
                                row["status"] = "OK"
                                row["detail"] = "Legenda compatível embutida"
                                row["subdetail"] = "Sincronização pulada por hash compatível"
                                ok_count += 1
                                logs.append(f"[OK] {row['video']}: hash compatível, softsub embutida")
                                emit_row("finalizado", 100, "ok")
                            except Exception as exc:
                                row["status"] = "FALHOU"
                                row["detail"] = "Erro ao embutir softsub"
                                row["subdetail"] = str(exc)[:160]
                                fail_count += 1
                                logs.append(f"[FALHOU] {row['video']}: {exc}")
                                emit_row("falhou no ffmpeg", 95, "fail")
                    else:
                        row["status"] = "OK"
                        row["detail"] = "Legenda compatível por hash"
                        row["subdetail"] = "Sincronização pulada"
                        ok_count += 1
                        logs.append(f"[OK] {row['video']}: hash compatível, ALASS pulado")
                        emit_row("finalizado", 100, "ok")
                    processed += 1
                    emit("row_result", {"index": index, "total": total, "done": processed, "row": row})
                    emit("job_progress", {"done": processed, "total": total})
                    continue
            elif provider_logs:
                emit_row("download", 36, "fail")
        if row.get("status") == "PULADO" and "embutida" in row.get("detail", "").lower() and not req.force_download:
            logs.append(f"[PULADO] {row['video']}: legenda embutida")
            emit_row("pulado", 100, "idle")
            processed += 1
            emit("row_result", {"index": index, "total": total, "done": processed, "row": row})
            emit("job_progress", {"done": processed, "total": total})
            continue
        if not sub:
            if (not req.ignore_embedded_subtitles) and not find_ffprobe():
                row["status"] = "FALHOU"
                row["detail"] = "Sem legenda"
                row["subdetail"] = "ffprobe não encontrado para verificar trilhas embutidas"
                fail_count += 1
                logs.append(f"[FALHOU] {row['video']}: ffprobe não encontrado")
                emit_row("sem legenda", 0, "fail")
                processed += 1
                emit("row_result", {"index": index, "total": total, "done": processed, "row": row})
                emit("job_progress", {"done": processed, "total": total})
                continue
            if (not req.ignore_embedded_subtitles) and has_embedded_subtitle(video_path, req.language):
                row["status"] = "PULADO"
                row["detail"] = "Legenda embutida detectada"
                row["subdetail"] = "Idioma alvo detectado nas trilhas embutidas"
                logs.append(f"[PULADO] {row['video']}: legenda embutida ({req.language})")
                emit_row("embutida", 100, "idle")
                processed += 1
                emit("row_result", {"index": index, "total": total, "done": processed, "row": row})
                emit("job_progress", {"done": processed, "total": total})
                continue
            row["status"] = "FALHOU"
            if row.get("detail") not in {"Download da legenda falhou", "Legenda encontrada"}:
                row["detail"] = "Sem legenda"
            fail_count += 1
            logs.append(f"[FALHOU] {row['video']}: {row['detail'].lower()}")
            emit_row("sem legenda", 0, "fail")
            processed += 1
            emit("row_result", {"index": index, "total": total, "done": processed, "row": row})
            emit("job_progress", {"done": processed, "total": total})
            continue

        out_path = Path(row["output_full"])
        vid_path = Path(row["video_full"])
        sub_path = normalize_subtitle_to_utf8(Path(sub))
        sub = str(sub_path)
        if not req.force_resync and out_path.exists() and out_path.stat().st_mtime >= max(
            vid_path.stat().st_mtime, sub_path.stat().st_mtime
        ):
            row["status"] = "PULADO"
            row["detail"] = "Ja sincronizada"
            logs.append(f"[PULADO] {row['video']}")
            emit_row("ja sincronizada", 100, "idle")
            processed += 1
            emit("row_result", {"index": index, "total": total, "done": processed, "row": row})
            emit("job_progress", {"done": processed, "total": total})
            continue

        cmd = [alass, row["video_full"], sub, row["output_full"]]
        attempts = max(1, int(req.retries) + 1)
        timeout = max(30, int(req.timeout_seconds or 900))
        try:
            emit_row("alass", 61, "run")
            result = None
            for attempt in range(1, attempts + 1):
                result = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=timeout, creationflags=SUBPROCESS_FLAGS)
                if result.returncode == 0:
                    break
                if attempt < attempts:
                    logs.append(f"[RETRY] {row['video']}: tentativa {attempt + 1}/{attempts}")
                    emit_row(f"alass (retry {attempt + 1})", 61, "run")
            if result is None:
                raise RuntimeError("ALASS não executou")
            if result.returncode == 0:
                if req.embed_softsub:
                    emit_row("embutindo softsub", 92, "run")
                    try:
                        muxed_path = embed_subtitle(
                            ffmpeg=ffmpeg or "",
                            video_path=Path(row["video_full"]),
                            subtitle_path=Path(row["output_full"]),
                            output_dir=Path(row["output_full"]).parent,
                            update_original=req.update_original,
                            keep_bak=True,
                            subtitle_default=req.subtitle_default,
                            subtitle_track=req.subtitle_track,
                            language=req.language,
                            timeout=timeout,
                        )
                        row["output"] = muxed_path.name
                        row["outputPath"] = str(muxed_path.parent) + "\\"
                        row["status"] = "OK"
                        row["detail"] = "Sincronizada e embutida"
                        row["subdetail"] = "Arquivo original atualizado" if req.update_original else "Softsub gerada"
                        ok_count += 1
                        logs.append(f"[OK] {row['video']}: softsub embutida")
                        emit_row("finalizado", 100, "ok")
                    except Exception as exc:
                        row["status"] = "FALHOU"
                        row["detail"] = "Erro ao embutir softsub"
                        row["subdetail"] = str(exc)[:160]
                        fail_count += 1
                        logs.append(f"[FALHOU] {row['video']}: {exc}")
                        emit_row("falhou no ffmpeg", 95, "fail")
                else:
                    row["status"] = "OK"
                    row["detail"] = "Sincronizada"
                    row["subdetail"] = ""
                    ok_count += 1
                    logs.append(f"[OK] {row['video']}")
                    emit_row("finalizado", 100, "ok")
            else:
                row["status"] = "FALHOU"
                row["detail"] = "Erro ao sincronizar (ALASS)"
                row["subdetail"] = (result.stderr or result.stdout or "Erro desconhecido").strip()[:160]
                fail_count += 1
                logs.append(f"[FALHOU] {row['video']}: {row['subdetail']}")
                emit_row("falhou no alass", 63, "fail")
        except Exception as exc:
            row["status"] = "FALHOU"
            row["detail"] = "Erro ao sincronizar (ALASS)"
            row["subdetail"] = str(exc)[:160]
            fail_count += 1
            logs.append(f"[FALHOU] {row['video']}: {exc}")
            emit_row("falhou no alass", 63, "fail")

        processed += 1
        emit("row_result", {"index": index, "total": total, "done": processed, "row": row})
        emit("job_progress", {"done": processed, "total": total})

    return {
        "ok": True,
        "rows": rows,
        "summary": {"total": len(rows), "ok": ok_count, "fail": fail_count},
        "logs": logs,
    }


@app.post("/sync")
def sync(req: SyncRequest) -> dict:
    return run_sync_core(req)


def run_sync_job(job_id: str, req: SyncRequest) -> None:
    job = get_sync_job(job_id)
    if job is None:
        return
    with SYNC_JOBS_LOCK:
        job["status"] = "running"
        job["pause_state"] = "running"
        job["updated_at"] = utc_now()
    sync_job_event(job, "job_started", {"job_id": job_id})

    def wait_if_paused(row: dict, index: int, total: int) -> bool:
        pause_announced = False
        while True:
            with SYNC_JOBS_LOCK:
                cancel_requested = bool(job.get("cancel_requested", False))
                paused = bool(job.get("paused", False))
            if cancel_requested:
                sync_job_event(job, "job_cancelled", {"job_id": job_id, "index": index, "total": total})
                return False
            if not paused:
                if pause_announced:
                    with SYNC_JOBS_LOCK:
                        job["pause_state"] = "running"
                        job["updated_at"] = utc_now()
                    sync_job_event(job, "job_resumed", {"job_id": job_id})
                return True
            if not pause_announced:
                row_video_full = str(row.get("video_full", ""))
                row_video_name = str(row.get("video", ""))
                with SYNC_JOBS_LOCK:
                    job["pause_state"] = "paused"
                    job["updated_at"] = utc_now()
                sync_job_event(job, "job_paused", {"job_id": job_id})
                sync_job_event(
                    job,
                    "row_progress",
                    {
                        "index": index,
                        "total": total,
                        "video_full": row_video_full,
                        "video": row_video_name,
                        "status": row.get("status"),
                        "stage": "pausado",
                        "percent": 0,
                        "tone": "idle",
                        "detail": "Fila pausada",
                        "subdetail": "Aguardando continuar para iniciar este arquivo",
                    },
                )
                pause_announced = True
            time.sleep(0.5)

    try:
        result = run_sync_core(
            req,
            on_event=lambda event_type, payload: sync_job_event(job, event_type, payload),
            before_row=wait_if_paused,
        )
        with SYNC_JOBS_LOCK:
            cancelled = bool(job.get("cancel_requested", False))
            job["status"] = "cancelled" if cancelled else "done"
            job["updated_at"] = utc_now()
            job["result"] = result
            job["rows"] = result.get("rows", [])
            job["logs"] = result.get("logs", [])
            job["summary"] = result.get("summary", {})
        sync_job_event(
            job,
            "job_finished",
            {
                "job_id": job_id,
                "cancelled": cancelled,
                "summary": result.get("summary", {}),
                "rows": result.get("rows", []),
                "logs": result.get("logs", []),
            },
        )
    except Exception as exc:
        with SYNC_JOBS_LOCK:
            job["status"] = "failed"
            job["updated_at"] = utc_now()
            job["error"] = str(exc)
        sync_job_event(job, "job_failed", {"job_id": job_id, "error": str(exc)})


@app.post("/sync/start")
def sync_start(req: SyncRequest) -> dict:
    remove_old_sync_jobs()
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "status": "queued",
        "created_at": utc_now(),
        "updated_at": utc_now(),
        "events": [],
        "queue": queue.Queue(),
        "next_seq": 1,
        "error": "",
        "result": None,
        "rows": [],
        "logs": [],
        "summary": {},
        "paused": False,
        "pause_state": "running",
        "cancel_requested": False,
    }
    with SYNC_JOBS_LOCK:
        SYNC_JOBS[job_id] = job
    thread = threading.Thread(target=run_sync_job, args=(job_id, req), daemon=True)
    thread.start()
    return {"ok": True, "job_id": job_id}


@app.get("/sync/status/{job_id}")
def sync_status(job_id: str) -> dict:
    job = get_sync_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job não encontrado")
    with SYNC_JOBS_LOCK:
        return {
            "ok": True,
            "job_id": job_id,
            "status": job.get("status"),
            "created_at": job.get("created_at"),
            "updated_at": job.get("updated_at"),
            "error": job.get("error", ""),
            "summary": job.get("summary", {}),
            "paused": bool(job.get("paused", False)),
            "pause_state": job.get("pause_state", "paused" if bool(job.get("paused", False)) else "running"),
            "cancel_requested": bool(job.get("cancel_requested", False)),
        }


@app.post("/sync/pause/{job_id}")
def sync_pause(job_id: str) -> dict:
    job = get_sync_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job não encontrado")
    with SYNC_JOBS_LOCK:
        if str(job.get("status")) not in {"queued", "running"}:
            return {"ok": False, "error": "Job não está em execução"}
        job["paused"] = True
        job["pause_state"] = "pausing"
        job["updated_at"] = utc_now()
    sync_job_event(job, "job_pause_requested", {"job_id": job_id})
    return {"ok": True, "job_id": job_id, "paused": True, "pause_state": "pausing"}


@app.post("/sync/resume/{job_id}")
def sync_resume(job_id: str) -> dict:
    job = get_sync_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job não encontrado")
    with SYNC_JOBS_LOCK:
        if str(job.get("status")) not in {"queued", "running"}:
            return {"ok": False, "error": "Job não está em execução"}
        job["paused"] = False
        job["pause_state"] = "running"
        job["updated_at"] = utc_now()
    sync_job_event(job, "job_resumed", {"job_id": job_id})
    return {"ok": True, "job_id": job_id, "paused": False, "pause_state": "running"}


@app.post("/sync/cancel/{job_id}")
def sync_cancel(job_id: str) -> dict:
    job = get_sync_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job não encontrado")
    with SYNC_JOBS_LOCK:
        if str(job.get("status")) not in {"queued", "running"}:
            return {"ok": False, "error": "Job não está em execução"}
        job["cancel_requested"] = True
        job["paused"] = False
        job["pause_state"] = "cancelling"
        job["updated_at"] = utc_now()
    sync_job_event(job, "job_cancel_requested", {"job_id": job_id})
    return {"ok": True, "job_id": job_id, "cancel_requested": True, "pause_state": "cancelling"}


@app.get("/sync/result/{job_id}")
def sync_result(job_id: str) -> dict:
    job = get_sync_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job não encontrado")
    with SYNC_JOBS_LOCK:
        return {
            "ok": True,
            "job_id": job_id,
            "status": job.get("status"),
            "created_at": job.get("created_at"),
            "updated_at": job.get("updated_at"),
            "error": job.get("error", ""),
            "summary": job.get("summary", {}),
            "rows": job.get("rows", []),
            "logs": job.get("logs", []),
            "result": job.get("result"),
            "paused": bool(job.get("paused", False)),
            "pause_state": job.get("pause_state", "paused" if bool(job.get("paused", False)) else "running"),
            "cancel_requested": bool(job.get("cancel_requested", False)),
        }


@app.get("/sync/events/{job_id}")
def sync_events(job_id: str, cursor: int = 0):
    job = get_sync_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job não encontrado")

    def generate():
        sent = max(0, int(cursor))
        while True:
            with SYNC_JOBS_LOCK:
                events = list(job.get("events", []))
                status = str(job.get("status", "queued"))
            while sent < len(events):
                event = events[sent]
                sent += 1
                yield f"id: {event.get('seq', sent)}\n"
                yield f"event: {event.get('type', 'message')}\n"
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

            if status in {"done", "failed", "cancelled"}:
                break

            try:
                queued_event = job.get("queue").get(timeout=15)
            except queue.Empty:
                yield "event: ping\ndata: {}\n\n"
                continue

            with SYNC_JOBS_LOCK:
                events = list(job.get("events", []))
            if sent >= len(events):
                seq = queued_event.get("seq", sent + 1)
                yield f"id: {seq}\n"
                yield f"event: {queued_event.get('type', 'message')}\n"
                yield f"data: {json.dumps(queued_event, ensure_ascii=False)}\n\n"
                sent += 1

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )
