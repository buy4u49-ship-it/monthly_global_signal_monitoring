import argparse
import json
import re
import tempfile
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont as ReportLabTTFont
from reportlab.pdfgen import canvas


PAGE_W = 7.5 * 72
PAGE_H = 10.8333333333 * 72

NAVY = colors.HexColor("#122844")
GOLD = colors.HexColor("#DCA72F")
LIGHT = colors.HexColor("#EEF3F7")
TABLE_LINE = colors.HexColor("#D8DDE4")
BOX_LINE = colors.HexColor("#E4EAF0")
TEAL_BG = colors.HexColor("#EAF7F4")
TEAL_LINE = colors.HexColor("#9EDCD3")
TEXT = colors.HexColor("#10243E")
MUTED = colors.HexColor("#8591A3")
GREY_TEXT = colors.HexColor("#B1B6BE")
WHITE = colors.white

DEFAULT_ISSUE_NUMBER = "2"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
TARGET_EMOJI_PATH = PROJECT_ROOT / "assets" / "images" / "emoji_target_1f3af.png"
KOTRA_LOGO_PATH = PROJECT_ROOT / "assets" / "images" / "kotra_logo_white.png"
INVEST_KOREA_LOGO_PATH = PROJECT_ROOT / "assets" / "images" / "invest_korea_logo_white.png"
FONT_WEIGHTS = {
    "demilight": 350,
    "medium": 500,
    "semibold": 600,
    "extrabold": 800,
}
FONT_FILES = {
    "demilight": "NotoSansKR-DemiLight.ttf",
    "medium": "NotoSansKR-Medium.ttf",
    "semibold": "NotoSansKR-SemiBold.ttf",
    "extrabold": "NotoSansKR-ExtraBold.ttf",
}


def normalize_company_key(value):
    return re.sub(r"\s+", " ", str(value or "")).strip().casefold()


EXEMPT_COMPANIES = {
    "Prodrive",
    "JSR",
    "Applied Materials",
    "Amkor Technology",
    "Heraeus",
    "Toray",
    "3M",
    "Air Liquide",
    "Air Products",
}
TARGET_TECH_LABEL_COMPANIES = {
    normalize_company_key(company)
    for company in [
        "Charles River",
        "Texcell",
        "Schott Pharma",
        "West Pharmaceutical",
        "Cytiva",
        "GE Healthcare",
        "Thermo Fisher",
        "Eli Lilly and Company",
        "Eli Lilly and Compan",
        "Moderna",
        "Asahi Glass",
        "Infineon",
        "NXP",
        "Mitsubishi Chemical",
        "Nexeon",
        "EMM(Umicore)",
        "Norsk Hydro",
        "TIMET",
        "Australian Strategic Metals",
        "HyproMag",
        "Shin-Etsu Chemicals",
        "Evonik Industries",
        "Solvay",
        "Air Products",
        "Asahi Kasei",
        "BASF",
    ]
}

COUNTRY_BY_COMPANY = {
    "Australian Strategic Metals": "호주",
    "Cognex": "미국",
    "Corning": "미국",
    "Charles River": "미국",
    "Cytiva": "미국",
    "Moderna": "미국",
    "West Pharmaceutical": "미국",
    "Dupont": "미국",
    "Albemarle": "미국",
    "TIMET": "미국",
    "Air Products": "미국",
    "Chemours": "미국",
    "BorgWarner": "미국",
    "DOW": "미국",
    "Thermo Fisher": "미국",
    "Amkor Technology": "미국",
    "Onsemi": "미국",
    "Qualcomm": "미국",
    "Skyworks": "미국",
    "Eli Lilly and Company": "미국",
    "GE Healthcare": "미국",
    "Boeing": "미국",
    "3M": "미국",
    "Ouster": "미국",
    "Applied Materials": "미국",
    "Magnix": "미국",
    "Prodrive": "네덜란드",
    "ASML": "네덜란드",
    "Besi": "네덜란드",
    "NXP": "네덜란드",
    "Norsk Hydro": "노르웨이",
    "Vestas": "덴마크",
    "Heidenhain": "독일",
    "Infineon": "독일",
    "Schmalz": "독일",
    "Bayer": "독일",
    "Merck": "독일",
    "Schott Pharma": "독일",
    "BASF": "독일",
    "Evonik Industries": "독일",
    "Heraeus": "독일",
    "Jenoptik": "독일",
    "EMM(Umicore)": "벨기에",
    "Umicore": "벨기에",
    "Solvay": "벨기에",
    "Syensqo": "벨기에",
    "Hexagon AB": "스웨덴",
    "ABB": "스위스",
    "Maxon": "스위스",
    "Siemens-Gamesa": "스페인",
    "Renishaw": "영국",
    "Nexeon": "영국",
    "Rio Tinto": "영국",
    "HyproMag": "영국",
    "EVG": "오스트리아",
    "Plansee": "오스트리아",
    "Texcell": "프랑스",
    "Veolia": "프랑스",
    "Airbus": "프랑스",
    "Safran": "프랑스",
    "Air Liquide": "프랑스",
    "Arkema": "프랑스",
    "DNP": "일본",
    "Hitachi Metals": "일본",
    "Toppan Holdings": "일본",
    "Nabtesco": "일본",
    "Asahi Glass": "일본",
    "JSR": "일본",
    "Shin-Etsu Chemicals": "일본",
    "Tokyo Electron": "일본",
    "Tosoh": "일본",
    "Mitsubishi Chemical": "일본",
    "Sumitomo Chemical": "일본",
    "Asahi Kasei": "일본",
    "Toray": "일본",
    "Cheng Uei Precision": "대만",
    "Shanghai Electric Wind Power": "중국",
}

DETAILED_INDUSTRY_BY_GROUP = {
    "rare_earth_magnet_recycling": "희토류 자석 재활용",
    "3d_vision_sensor": "머신비전·센서",
    "euv_blank_mask": "반도체 마스크 소재",
    "virus_validation_mcb_wcb": "바이오 분석·안전성 시험",
    "bioprocess_culture_purification": "바이오공정 장비·소재",
    "gene_cell_therapy_delivery_gmp": "세포·유전자 치료제",
    "autoinjector_pfs_fill_finish": "의약품 전달·충전",
    "ag_al_paste": "태양전지 전극소재",
    "lithium_cathode_materials": "이차전지 핵심소재",
    "nonferrous_scrap_recycling": "비철금속 재활용",
    "hexamethylenediamine_hmd": "화학 플랫폼 원료",
    "ion_exchange_membrane": "첨단막 소재",
    "autonomous_imu_rf_baseband": "자율주행 반도체",
    "semiconductor_thermal_material": "반도체 패키징",
    "autonomous_camera_isp": "자율주행 센싱",
    "aerospace_electric_propulsion": "항공기·친환경 추진체계",
    "robot_lidar": "로봇용 라이다",
    "hybrid_bonding_w2w": "첨단 패키징 장비",
    "euv_lithography": "반도체 노광장비",
    "satellite_radar_rf_semiconductor": "우주항공 RF 반도체",
    "offshore_wind_turbine": "해상풍력 터빈",
    "linear_scale": "정밀 위치계측",
    "robot_reducer": "로봇 정밀구동",
    "pharma_excipient": "의약품 소재",
    "precipitated_silica_tire": "친환경 실리카",
    "silicon_anode_sic": "이차전지 음극재",
    "pvdf": "이차전지 바인더 소재",
    "metal_target_ti_ta": "반도체 금속타겟",
    "fine_metal_mask": "디스플레이 소재",
    "tgv_glass_substrate": "반도체 유리기판",
}

SIGNAL_DESCRIPTIONS = {
    1: "공급망·지정학 리스크 대응 · 공급망 재편·지정학 리스크 발생 및 대응 등",
    2: "생산 확대 및 다변화 의지 · 증설·거점 다변화 검토·타당성 조사 등",
    3: "투자 재원 확보 · 회사채·증자·신용공여 등 대규모 자금 조달",
    4: "기술 생태계 밀착 (R&D) · 공동연구·라이선싱·PoC·지분투자 타진 등",
    5: "핵심 전략 인력의 이동 · C-Level 이동·극비 방한·실사 조율 등",
}

# 국문 라벨 폭에 맞춰 짜인 알약·한 줄 슬롯에 그대로 들어가야 하므로 영문은 같은 뜻을 더 짧게 적는다.
SIGNAL_DESCRIPTIONS_EN = {
    1: "Supply chain & geopolitical risk · shifts, risk events, responses",
    2: "Production expansion · capacity, site diversification, feasibility",
    3: "Investment financing · bonds, equity raises, credit facilities",
    4: "Technology ecosystem (R&D) · joint research, licensing, PoC",
    5: "Key personnel movement · C-level moves, visits, due diligence",
}

INDICATOR_DESCRIPTION_EN = {
    1: "Supply chain shifts and risk responses",
    2: "Capacity additions, site diversification",
    3: "Bonds, equity raises, credit facilities",
    4: "Joint research, licensing, PoC, equity",
    5: "C-level moves, visits, due diligence",
}

COUNTRY_EN = {
    "호주": "Australia",
    "미국": "USA",
    "네덜란드": "Netherlands",
    "노르웨이": "Norway",
    "덴마크": "Denmark",
    "독일": "Germany",
    "벨기에": "Belgium",
    "스웨덴": "Sweden",
    "스위스": "Switzerland",
    "스페인": "Spain",
    "영국": "UK",
    "오스트리아": "Austria",
    "프랑스": "France",
    "일본": "Japan",
    "대만": "Taiwan",
    "중국": "China",
}

DETAILED_INDUSTRY_EN = {
    "rare_earth_magnet_recycling": "Rare-earth magnet recycling",
    "3d_vision_sensor": "Machine vision & sensors",
    "euv_blank_mask": "EUV mask materials",
    "virus_validation_mcb_wcb": "Bioanalysis & safety testing",
    "bioprocess_culture_purification": "Bioprocess equipment",
    "gene_cell_therapy_delivery_gmp": "Cell & gene therapy",
    "autoinjector_pfs_fill_finish": "Drug delivery & fill-finish",
    "ag_al_paste": "Solar electrode materials",
    "lithium_cathode_materials": "Battery cathode materials",
    "nonferrous_scrap_recycling": "Non-ferrous metal recycling",
    "hexamethylenediamine_hmd": "Chemical platform feedstock",
    "ion_exchange_membrane": "Advanced membranes",
    "autonomous_imu_rf_baseband": "Autonomous driving chips",
    "semiconductor_thermal_material": "Semiconductor packaging",
    "autonomous_camera_isp": "Autonomous driving sensing",
    "aerospace_electric_propulsion": "Aircraft & clean propulsion",
    "robot_lidar": "Robotics LiDAR",
    "hybrid_bonding_w2w": "Advanced packaging",
    "euv_lithography": "Semiconductor lithography",
    "satellite_radar_rf_semiconductor": "Aerospace RF chips",
    "offshore_wind_turbine": "Offshore wind turbines",
    "linear_scale": "Precision position metrology",
    "robot_reducer": "Robot precision drives",
    "pharma_excipient": "Pharmaceutical materials",
    "precipitated_silica_tire": "Eco-friendly silica",
    "silicon_anode_sic": "Battery anode materials",
    "pvdf": "Battery binder materials",
    "metal_target_ti_ta": "Semiconductor targets",
    "fine_metal_mask": "Display materials",
    "tgv_glass_substrate": "Glass core substrates",
}

MONTH_NAMES_EN = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]

TEXTS = {
    "ko": {
        "footer": "Invest KOREA · 타겟기업 글로벌 투자시그널 모니터링 · {issue}",
        "cover_title_1": "타겟기업",
        "cover_title_2": "글로벌 투자시그널",
        "cover_title_3": "모니터링",
        "cover_line_1": "산업부 선정 30대 투자유치 프로젝트 · 77개 타겟기업",
        "cover_line_2": "기업별 5대 시그널(전조현상) 포착 · 투자 검토·전조 활동 근거 기반",
        "cover_indicator_heading": "5대 투자동향 지표",
        "matrix_title": "이번 달 시그널 매트릭스",
        "matrix_desc": "77개 타겟기업의 {period} 글로벌 투자 시그널(전조현상). 활성화된 셀 = 당월 포착된 시그널 (최종 투자 확정·완료 제외, 조달·연구협업 등 전조 활동 포함).",
        "matrix_company": "기업",
        "matrix_legend_on": "시그널 포착",
        "matrix_legend_off": "미포착",
        "matrix_indicators": "① 공급망·지정학 리스크 대응 · ② 생산 확대·다변화 의지 · ③ 투자 재원 확보 · ④ 기술 생태계 밀착(R&D) · ⑤ 핵심 전략 인력의 이동",
        "matrix_footnote": "당월 시그널 포착 {on}개사 · 자료 검토 후 미포착 {reviewed_off}개사 · 수집근거 부족 {insufficient}개사",
        "detail_title": "기업별 시그널 상세",
        "no_signal": "이번 달 해당 신호 미포착",
        "business_heading": "글로벌 사업현황",
        "business_empty": "해당 기간에 공식 출처 기반으로 요약할 수 있는 글로벌 사업현황 신호가 확인되지 않는다.",
        "target_item": "타겟품목",
        "target_tech": "타겟기술",
        "source_prefix": "출처",
        "source_fallback": "수집 출처",
        "source_empty": "출처  -",
        "source_press_release": "공식보도자료",
        "item_title": "품목별 글로벌 사업동향",
        "item_target_label": "투자유치 필요 품목·기술",
        "item_trend_label": "{month} 글로벌 사업동향",
        "item_note": "5대 시그널에는 미포착되었으나, {month}중 투자유치 필요 품목·기술과 직접 연계되는 글로벌 사업동향이 포착된 기업. 향후 시그널 발전 가능성을 모니터링함.",
    },
    "en": {
        "footer": "Invest KOREA · Global Investment Signal Monitoring · {issue}",
        "cover_title_1": "Target Companies",
        "cover_title_2": "Global Investment Signals",
        "cover_title_3": "Monitoring",
        "cover_line_1": "30 priority investment projects selected by MOTIE · 77 target companies",
        "cover_line_2": "Five leading signals per company · Investment plans and enabling activities",
        "cover_indicator_heading": "Five investment trend indicators",
        "matrix_title": "Signal Matrix of the Month",
        "matrix_desc": "Global investment signals (leading indicators) across 77 target companies for {period}. A filled cell marks a signal captured during the month; final investment commitments are excluded; financing and R&D precursors are included.",
        "matrix_company": "Company",
        "matrix_legend_on": "Signal captured",
        "matrix_legend_off": "Not detected",
        "matrix_indicators": "① Supply chain & geopolitical risk · ② Production expansion · ③ Investment financing · ④ Technology ecosystem · ⑤ Key personnel movement",
        "matrix_footnote": "{on} detected · {reviewed_off} not detected in reviewed sources · {insufficient} insufficient coverage",
        "detail_title": "Company Signal Detail",
        "no_signal": "No signal detected this month",
        "business_heading": "GLOBAL BUSINESS",
        "business_empty": "No global business activity could be summarised from official sources for this period.",
        "target_item": "Target item",
        "target_tech": "Target technology",
        "source_prefix": "Source",
        "source_fallback": "Collected source",
        "source_empty": "Source  -",
        "source_press_release": "Official press release",
        "item_title": "Global Business Trends by Item",
        "item_target_label": "Target item / technology",
        "item_trend_label": "Global business trend, {month}",
        "item_note": "Companies with no signal among the five indicators this month, but with global business activity in {month} directly tied to their target item or technology. Monitored for potential escalation into a signal.",
    },
}

LANG = "ko"


def set_language(lang):
    global LANG
    LANG = "en" if str(lang or "").strip().lower() in ("en", "eng", "english") else "ko"
    return LANG


def t(key, **kwargs):
    text = TEXTS.get(LANG, TEXTS["ko"]).get(key) or TEXTS["ko"].get(key, "")
    return text.format(**kwargs) if kwargs else text


def summary_field(row, name):
    """언어별 AI 요약 필드를 고른다. 영문판에서 영문 요약이 없으면 국문으로 대체하지 않는다."""
    suffix = "en" if LANG == "en" else "ko"
    return row.get(f"{name}_{suffix}") or ""


def load_json(path, fallback):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return fallback


def parse_datetime(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def parse_date_only(value):
    if not value:
        return None
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def format_date(value):
    dt = parse_datetime(value)
    if dt:
        return dt.strftime("%Y.%m.%d")
    return str(value or "-")[:10]


def issue_month(summary):
    to_date = parse_date_only(summary.get("to_date"))
    if to_date:
        year = to_date.year + (1 if to_date.month == 12 else 0)
        month = 1 if to_date.month == 12 else to_date.month + 1
        return f"{year}.{month:02d}"
    dt = parse_datetime(summary.get("run_started_at")) or datetime.now(timezone.utc)
    return dt.astimezone(timezone(timedelta(hours=9))).strftime("%Y.%m")


def report_period(summary):
    from_date = parse_date_only(summary.get("from_date"))
    to_date = parse_date_only(summary.get("to_date"))
    if from_date and to_date:
        return from_date, to_date

    dt = parse_datetime(summary.get("run_started_at")) or datetime.now(timezone.utc)
    local = dt.astimezone(timezone(timedelta(hours=9)))
    first_this_month = local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    last_prev_month = first_this_month - timedelta(days=1)
    first_prev_month = last_prev_month.replace(day=1)
    return first_prev_month, last_prev_month


def compact_date(dt, include_year=True):
    if include_year:
        return f"{dt.year}.{dt.month}.{dt.day}"
    return f"{dt.month}.{dt.day}"


def matrix_period_label(summary):
    start, end = report_period(summary)
    end_text = compact_date(end, include_year=start.year != end.year)
    if LANG == "en":
        return f"{MONTH_NAMES_EN[start.month - 1]} ({compact_date(start)}~{end_text})"
    return f"{start.month}월({compact_date(start)}~{end_text})"


def report_month_label(summary):
    start, _ = report_period(summary)
    if LANG == "en":
        return MONTH_NAMES_EN[start.month - 1]
    return f"{start.month}월"


def filter_rows_by_report_period(rows, summary):
    if not summary.get("from_date") or not summary.get("to_date"):
        return rows
    start, end = report_period(summary)
    start = start.replace(hour=0, minute=0, second=0, microsecond=0)
    end = end.replace(hour=23, minute=59, second=59, microsecond=999999)
    filtered = []
    for row in rows:
        published = parse_datetime(row.get("published_at"))
        if not published:
            # 게시일을 확인할 수 없는 항목은 월간 보고서에서 제외한다. 기간이 문서의 전제이기 때문이다.
            # 웹 화면에서는 '게시일 미상'으로 표시해 그대로 남긴다.
            continue
        if published.tzinfo is None:
            published = published.replace(tzinfo=timezone.utc)
        if start <= published.astimezone(timezone.utc) <= end:
            filtered.append(row)
    return filtered


def short_text(value, limit):
    text = " ".join(str(value or "").replace("&nbsp;", " ").split())
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)].rstrip() + "..."


def clean_text(value):
    text = str(value or "").replace("&nbsp;", " ")
    text = re.sub(r"\s+", " ", text).strip()
    boilerplate = [
        "Skip to main navigation",
        "Investor Relations",
        "News Release",
        "PDF Version",
        "View printer-friendly version",
    ]
    for phrase in boilerplate:
        text = text.replace(phrase, " ")
    return re.sub(r"\s+", " ", text).strip()


def normalize_summary_text(value):
    text = clean_text(value)
    replacements = [
        ("중순수%", "한 자릿수 중반대"),
        ("저순수%", "한 자릿수 초반대"),
        ("고순수%", "한 자릿수 후반대"),
        ("중순수", "한 자릿수 중반대"),
        ("저순수", "한 자릿수 초반대"),
        ("고순수", "한 자릿수 후반대"),
        ("중반 두 자릿수", "두 자릿수 중반대"),
        ("초반 두 자릿수", "두 자릿수 초반대"),
        ("후반 두 자릿수", "두 자릿수 후반대"),
        ("중반대 두 자릿수", "두 자릿수 중반대"),
        ("초반대 두 자릿수", "두 자릿수 초반대"),
        ("후반대 두 자릿수", "두 자릿수 후반대"),
        ("उपलब्ध성", "가용성"),
    ]
    for source, target in replacements:
        text = text.replace(source, target)
    return text.strip()


def strip_summary_lead(value, row=None):
    text = normalize_summary_text(value)
    company = clean_text((row or {}).get("company"))
    if company:
        text = re.sub(rf"^{re.escape(company)}(은|는|이|가)\s+", "", text)
    text = re.sub(r"^[A-Za-z0-9().&/-]+(?:\s+[A-Za-z0-9().&/-]+){0,3}(은|는|이|가)\s+", "", text)
    text = re.sub(r"^[가-힣A-Za-z0-9().·&/-]+(?:와\s+[가-힣A-Za-z0-9().·&/-]+)?(은|는|이|가)\s+", "", text)
    text = re.sub(r"^(이는|다만|또한)\s+", "", text)
    text = re.sub(r"([A-Za-z][A-Za-z0-9().·&/-]*)의\s+", r"\1 ", text)
    return text.strip()


def phrase_ending_text(value):
    text = clean_text(value)
    replacements = [
        (r"확인되지\s+(않았다|않는다)$", "확인되지 않음"),
        (r"제시되지\s+(않았다|않는다)$", "제시되지 않음"),
        (r"나타나지\s+(않았다|않는다)$", "나타나지 않음"),
        (r"부족하다$", "부족"),
        (r"필요하다$", "필요"),
        (r"계획이다$", "계획"),
        (r"예정이다$", "예정"),
        (r"목표로\s+하고\s+있다$", "목표"),
        (r"추진\s+중이다$", "추진"),
        (r"검토\s+중이다$", "검토"),
        (r"진행\s+중이다$", "진행"),
        (r"이어지고\s+있다$", "지속"),
        (r"진행하고\s+있다$", "진행"),
        (r"추진하고\s+있다$", "추진"),
        (r"검토하고\s+있다$", "검토"),
        (r"보여준다$", "시사"),
        (r"시사한다$", "시사"),
        (r"해석된다$", "해석"),
        (r"판단된다$", "판단"),
        (r"예상된다$", "예상"),
        (r"확인된다$", "확인"),
        (r"확인됐다$", "확인"),
        (r"나타났다$", "확인"),
        (r"언급됐다$", "언급"),
        (r"언급했다$", "언급"),
        (r"발표됐다$", "발표"),
        (r"발표했다$", "발표"),
        (r"공개했다$", "공개"),
        (r"밝혔다$", "공개"),
        (r"체결했다$", "체결"),
        (r"서명했다$", "서명"),
        (r"선임했다$", "선임"),
        (r"인수했다$", "인수"),
        (r"완료했다$", "완료"),
        (r"가동했다$", "가동"),
        (r"기록했다$", "기록"),
        (r"제공한다$", "제공"),
        (r"제공했다$", "제공"),
        (r"지원한다$", "지원"),
        (r"지원했다$", "지원"),
        (r"적용한다$", "적용"),
        (r"적용했다$", "적용"),
        (r"수용했다$", "수용"),
        (r"확대한다$", "확대"),
        (r"확대했다$", "확대"),
        (r"강화한다$", "강화"),
        (r"강화했다$", "강화"),
        (r"구축한다$", "구축"),
        (r"구축했다$", "구축"),
        (r"개발한다$", "개발"),
        (r"개발했다$", "개발"),
        (r"운영한다$", "운영"),
        (r"운영했다$", "운영"),
        (r"있다$", ""),
        (r"없다$", "없음"),
        (r"된다$", ""),
        (r"됐다$", ""),
        (r"한다$", ""),
        (r"했다$", ""),
        (r"이다$", ""),
    ]
    for source, target in replacements:
        text = re.sub(source, target, text)
    return text.strip()


def phraseify_summary_text(value, row=None):
    # 아래 규칙은 한국어 조사·종결어미 정리용이라 영문에는 적용하지 않는다.
    if LANG != "ko":
        return clean_text(value)
    connector_map = {
        "구축하고": "구축",
        "확보하고": "확보",
        "강화하고": "강화",
        "확대하고": "확대",
        "공급하고": "공급",
        "체결하고": "체결",
        "수행하고": "수행",
        "협력하고": "협력",
        "진행하고": "진행",
        "도입하고": "도입",
        "설치하고": "설치",
        "시연하고": "시연",
        "개발하고": "개발",
        "운영하고": "운영",
        "공개하고": "공개",
        "투자하고": "투자",
        "언급하고": "언급",
        "기록하고": "기록",
        "가동하고": "가동",
        "완료하고": "완료",
        "발표하고": "발표",
        "제공하며": "제공",
        "적용하며": "적용",
        "추진하며": "추진",
        "검토하며": "검토",
        "밝혔으며": "공개",
        "발표했으며": "발표",
        "체결했으며": "체결",
        "기록했으며": "기록",
        "확인했으며": "확인",
    }
    text = strip_summary_lead(value, row)
    text = re.sub(r"([A-Za-z][A-Za-z0-9().·&/-]*)의\s+", r"\1 ", text)
    connector_pattern = "|".join(re.escape(key) for key in connector_map)
    text = re.sub(
        rf"({connector_pattern})(,\s*|\s+|$)",
        lambda match: f"{connector_map[match.group(1)]}{', ' if ',' in match.group(2) else ' '}",
        text,
    )
    text = re.sub(r"영향을\s+(줄|미칠)\s+수\s+있다고\s+밝혔다", "영향 가능성 언급", text)
    text = re.sub(r"수\s+있다고\s+밝혔다", "가능성 언급", text)
    text = re.sub(r"됐다고\s+(공개|발표|언급)", r" \1", text)
    text = re.sub(r"했다고\s+(공개|발표|언급)", r" \1", text)
    text = re.sub(r"([가-힣A-Za-z0-9/·().-]+)(됐|되었|했다|였다|었다|았다)고\s+(공개|발표|언급)", r"\1 \3", text)
    text = re.sub(r"(이라고 밝혔다|라고 밝혔다|다고 밝혔다|다고 발표했다|다고 설명했다|으로 확인됐다|로 확인됐다|이 확인됐다|가 확인됐다|를 확인했다|을 확인했다)", "", text)
    text = re.sub(r"\s+(다만|또한|그리고)\s+", ", ", text)
    text = re.sub(r"[.!?。]+", ". ", text)
    clauses = [
        phrase_ending_text(re.sub(r"^(이는|다만|또한|그리고)\s+", "", clause))
        for clause in re.split(r"\s*\.\s*|\s*;\s*", text)
    ]
    text = ", ".join(clause for clause in clauses if clause)
    text = re.sub(r"\s*,\s*,\s*", ", ", text)
    text = re.sub(r"(을|를)\s+(발표|공개|추진|검토|확보|제공|지원|적용|수용|확대|강화|구축|개발|운영|체결|서명|선임|인수|완료|가동|기록|시연|도입)(?=,|$)", r" \2", text)
    text = re.sub(r"(을|를)\s+단계적으로\s+추진", " 단계적 추진", text)
    text = re.sub(r"확대할\s+계획", "확대 계획", text)
    text = re.sub(r"(을|를)\s+위험요인으로\s+언급", " 위험요인 언급", text)
    text = re.sub(r"영향을\s+위험요인으로\s+언급", "영향 위험요인 언급", text)
    text = re.sub(r"(에|에서|와|과|으로|로)\s+(서명|참여|협력|착수|진입|진출|투자|가동|운영|적용)(?=,|$)", r" \2", text)
    text = re.sub(r"(이|가|은|는)\s+(확인|예상|증가|감소|지속|필요|부족|완료)(?=,|$)", r" \2", text)
    text = re.sub(r"(재활용|가동|확보|활용|도입|설치|시연|개발|운영|제공|적용|수행|체결|추진|완료)해\s+", r"\1·", text)
    text = re.sub(r"([가-힣A-Za-z0-9/·().-]+)하는\s+", r"\1 ", text)
    text = re.sub(r"([가-힣A-Za-z0-9/·().-]+)하려는\s+움직임으로\s+해석", r"\1 움직임", text)
    text = text.replace("계획은 확인되지 않음", "계획 확인되지 않음")
    text = text.replace("사실은 확인되지 않음", "사실 확인되지 않음")
    text = text.replace("근거는 확인되지 않음", "근거 확인되지 않음")
    text = text.replace("내용은 확인되지 않음", "내용 확인되지 않음")
    text = text.replace("관련성은 확인되지 않음", "관련성 확인되지 않음")
    text = text.replace("직접 연계는 확인되지 않음", "직접 연계 확인되지 않음")
    text = text.replace("직접적 연관성은 확인되지 않음", "직접 연관성 확인되지 않음")
    text = text.replace("연계도 확인되지 않음", "연계 확인되지 않음")
    text = re.sub(r",\s+[가-힣A-Za-z0-9().·&/-]+(?:와\s+[가-힣A-Za-z0-9().·&/-]+)?(은|는)\s+", ", ", text)
    text = text.replace("가능성을 시사", "가능성")
    text = re.sub(r",\s*(다만|또한)\s+", ", ", text)
    text = re.sub(r"\s*·\s*", "·", text)
    return re.sub(r"\s+", " ", text).strip()


def compact_summary_phrase(value, limit=90, row=None):
    return short_text(phraseify_summary_text(value, row), limit)


def summary_parts(row):
    headline_limit = 110 if LANG == "en" else 58
    # 본문이 최대 6줄까지 늘어날 수 있으므로 글자 수 상한이 먼저 걸리지 않게 잡는다.
    # 실제로 몇 줄을 싣을지는 draw_summary_text가 폭으로 판단한다.
    detail_limit = 440 if LANG == "en" else 230
    headline = compact_summary_phrase(summary_field(row, "ai_summary_headline"), headline_limit, row)
    detail = compact_summary_phrase(summary_field(row, "ai_summary_detail"), detail_limit, row)
    if headline or detail:
        return {
            "headline": headline or compact_summary_phrase(summary_field(row, "ai_summary"), headline_limit, row),
            "detail": detail,
        }

    text = normalize_summary_text(summary_field(row, "ai_summary"))
    if not text:
        return None

    dashed = re.split(r"\s[-–—]\s", text)
    if len(dashed) >= 2:
        return {
            "headline": compact_summary_phrase(dashed[0], headline_limit, row),
            "detail": compact_summary_phrase(" - ".join(dashed[1:]), detail_limit, row),
        }

    sentences = [item for item in re.split(r"(?<=[.!?。])\s+", text) if item]
    if len(sentences) >= 2:
        return {
            "headline": compact_summary_phrase(sentences[0], headline_limit, row),
            "detail": compact_summary_phrase(" ".join(sentences[1:]), detail_limit, row),
        }

    clauses = [item for item in re.split(r",\s*", text) if item]
    if len(clauses) >= 2:
        return {
            "headline": compact_summary_phrase(clauses[0], headline_limit, row),
            "detail": compact_summary_phrase(", ".join(clauses[1:]), detail_limit, row),
        }

    return {"headline": compact_summary_phrase(text, headline_limit, row), "detail": ""}


def summary_plain_text(row):
    parts = summary_parts(row)
    if not parts:
        return ""
    if parts["detail"]:
        return f"{parts['headline']} - {parts['detail']}"
    return parts["headline"]


def wrap_text(canvas_obj, text, max_width, font_name, font_size):
    text = clean_text(text)
    if not text:
        return [""]
    lines = []
    current = ""
    for token in text.split(" "):
        candidate = token if not current else f"{current} {token}"
        if canvas_obj.stringWidth(candidate, font_name, font_size) <= max_width:
            current = candidate
            continue
        if current:
            lines.append(current)
            current = token
            continue
        chunk = ""
        for char in token:
            candidate_chunk = f"{chunk}{char}"
            if canvas_obj.stringWidth(candidate_chunk, font_name, font_size) <= max_width:
                chunk = candidate_chunk
            else:
                if chunk:
                    lines.append(chunk)
                chunk = char
        current = chunk
    if current:
        lines.append(current)
    return lines


def short_text_to_width(canvas_obj, text, max_width, font_name, font_size):
    text = " ".join(str(text or "").replace("&nbsp;", " ").split())
    if not text:
        return ""
    if canvas_obj.stringWidth(text, font_name, font_size) <= max_width:
        return text
    suffix = "..."
    if canvas_obj.stringWidth(suffix, font_name, font_size) > max_width:
        return ""
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        candidate = text[:mid].rstrip() + suffix
        if canvas_obj.stringWidth(candidate, font_name, font_size) <= max_width:
            lo = mid
        else:
            hi = mid - 1
    head = text[:lo].rstrip()
    # 영문은 단어 중간에서 끊기면 뜻이 깨지므로 마지막 공백까지 되돌린다.
    # 한 단어를 통째로 버릴 만큼 많이 잘려나가면 그대로 둔다(한글처럼 공백이 드문 문장 보호).
    if " " in head and not text[lo : lo + 1].isspace():
        word_head = head.rsplit(" ", 1)[0].rstrip(" ,;:·-")
        if word_head and len(word_head) >= len(head) * 0.6:
            head = word_head
    return head + suffix if head else suffix


def split_sentences(text):
    return [sentence.strip() for sentence in re.split(r"(?<=[.!?。])\s+", str(text or "")) if sentence.strip()]


def fit_sentences(canvas_obj, text, max_width, font_name, font_size, max_lines):
    """주어진 줄 수 안에 들어가는 만큼만 문장 단위로 담아 문장 중간에서 잘리지 않게 한다."""
    text = clean_text(text)
    if not text:
        return ""
    sentences = split_sentences(text)
    if not sentences:
        return ""

    picked = ""
    for sentence in sentences:
        candidate = sentence if not picked else f"{picked} {sentence}"
        if len(wrap_text(canvas_obj, candidate, max_width, font_name, font_size)) > max_lines:
            break
        picked = candidate
    if picked:
        return picked

    # 첫 문장 하나도 줄 수를 넘으면 마지막 줄만 폭에 맞춰 줄인다.
    lines = wrap_text(canvas_obj, sentences[0], max_width, font_name, font_size)
    head = " ".join(lines[: max_lines - 1])
    tail = short_text_to_width(canvas_obj, f"{lines[max_lines - 1]}...", max_width, font_name, font_size)
    return f"{head} {tail}".strip()


def draw_justified_line(canvas_obj, x, y, line, max_width, font_name, font_size):
    words = line.split(" ")
    if len(words) <= 1:
        canvas_obj.drawString(x, y, line)
        return
    word_width = sum(canvas_obj.stringWidth(word, font_name, font_size) for word in words)
    gap_count = len(words) - 1
    gap_width = max((max_width - word_width) / gap_count, canvas_obj.stringWidth(" ", font_name, font_size))
    cursor = x
    for index, word in enumerate(words):
        canvas_obj.drawString(cursor, y, word)
        cursor += canvas_obj.stringWidth(word, font_name, font_size)
        if index < gap_count:
            cursor += gap_width


def instantiate_variable_font(font_path, weight, out_dir):
    from fontTools.ttLib import TTFont as FontToolsTTFont
    from fontTools.varLib import instancer

    font = FontToolsTTFont(str(font_path))
    instanced = instancer.instantiateVariableFont(font, {"wght": weight}, inplace=False)
    out_file = out_dir / f"NotoSansKR-{weight}.ttf"
    instanced.save(str(out_file))
    return out_file


def register_fonts(font_path):
    source = Path(font_path)
    temp_dir = Path(tempfile.mkdtemp(prefix="noto-sans-kr-"))
    fonts = {}
    try:
        for role, weight in FONT_WEIGHTS.items():
            static_file = source.parent / FONT_FILES[role]
            font_file = static_file if static_file.exists() else instantiate_variable_font(source, weight, temp_dir)
            font_name = f"NotoSansKR-{role}"
            report_font = ReportLabTTFont(font_name, str(font_file))
            report_font.face.name = font_name.encode("ascii")
            pdfmetrics.registerFont(report_font)
            fonts[role] = font_name
    except Exception:
        fonts = {}
        for role in FONT_WEIGHTS:
            font_name = f"NotoSansKR-{role}"
            report_font = ReportLabTTFont(font_name, str(source))
            report_font.face.name = font_name.encode("ascii")
            pdfmetrics.registerFont(report_font)
            fonts[role] = font_name
    return fonts


def signal_fingerprint(row):
    values = [
        row.get("target_no"),
        row.get("company"),
        row.get("investment_signal_no"),
    ]
    return "|".join(str(value) for value in values if value not in (None, ""))


def fnv1a_utf8(value):
    hash_value = 0x811C9DC5
    for byte in str(value).encode("utf-8"):
        hash_value ^= byte
        hash_value = (hash_value * 0x01000193) & 0xFFFFFFFF
    return f"{hash_value:08x}"


def parse_ignored_signal_keys(value):
    if not value:
        return set()
    return {item.strip() for item in str(value).split(",") if item.strip()}


def filter_ignored_signals(rows, ignored_keys):
    if not ignored_keys:
        return rows
    filtered = []
    for row in rows:
        fingerprint = signal_fingerprint(row)
        if fingerprint in ignored_keys or fnv1a_utf8(fingerprint) in ignored_keys:
            continue
        filtered.append(row)
    return filtered


def override_summary_period(summary, from_date=None, to_date=None):
    if not from_date and not to_date:
        return summary
    updated = dict(summary)
    if from_date:
        updated["from_date"] = str(from_date)[:10]
    if to_date:
        updated["to_date"] = str(to_date)[:10]
    return updated


class SlideReport:
    def __init__(self, out_path, fonts, issue_number):
        self.out_path = out_path
        self.fonts = fonts
        self.font = fonts["demilight"]
        self.bold_font = fonts["semibold"]
        self.issue_no = f"Issue {issue_number}"
        self.canvas = canvas.Canvas(str(out_path), pagesize=(PAGE_W, PAGE_H))
        self.page_no = 0

    def font_for(self, weight="demilight", bold=False):
        if bold:
            return self.fonts["semibold"]
        return self.fonts.get(weight, self.font)

    def set_font(self, size, color=TEXT, weight="demilight", bold=False):
        self.canvas.setFont(self.font_for(weight, bold), size)
        self.canvas.setFillColor(color)

    def text(self, x, y, value, size=10, color=TEXT, bold=False, align="left", weight="demilight"):
        self.set_font(size, color, weight=weight, bold=bold)
        value = str(value or "")
        if align == "right":
            self.canvas.drawRightString(x, y, value)
        elif align == "center":
            self.canvas.drawCentredString(x, y, value)
        else:
            self.canvas.drawString(x, y, value)

    def spaced_text(self, x, y, value, size=10, color=TEXT, weight="demilight", char_space=0.6):
        font_name = self.font_for(weight)
        self.set_font(size, color, weight=weight)
        cursor_x = x
        for char in str(value or ""):
            self.canvas.drawString(cursor_x, y, char)
            cursor_x += self.canvas.stringWidth(char, font_name, size) + char_space

    def wrapped(self, text, x, y, max_width, size=10, color=TEXT, max_lines=0, line_gap=3, bold=False, weight="demilight", align="left"):
        font_name = self.font_for(weight, bold)
        lines = wrap_text(self.canvas, text, max_width, font_name, size)
        if max_lines and len(lines) > max_lines:
            lines = lines[:max_lines]
            # 글자 수가 아니라 실제 폭으로 잘라야 영문에서도 마지막 줄이 폭을 넘지 않는다.
            last = lines[-1]
            if self.canvas.stringWidth(f"{last}...", font_name, size) <= max_width:
                lines[-1] = f"{last}..."
            else:
                lines[-1] = short_text_to_width(self.canvas, last, max_width, font_name, size)
        self.set_font(size, color, weight=weight, bold=bold)
        line_height = size + line_gap
        for line in lines:
            if align == "center":
                self.canvas.drawCentredString(x + max_width / 2, y, line)
            elif align == "justify" and line != lines[-1]:
                draw_justified_line(self.canvas, x, y, line, max_width, font_name, size)
            else:
                self.canvas.drawString(x, y, line)
            y -= line_height
        return y

    def new_page(self):
        if self.page_no:
            self.canvas.showPage()
        self.page_no += 1

    def footer(self):
        c = self.canvas
        c.setFillColor(colors.HexColor("#EFF4F8"))
        c.rect(0, 0, PAGE_W, 38, fill=1, stroke=0)
        c.setStrokeColor(TABLE_LINE)
        c.setLineWidth(0.7)
        c.line(0, 38, PAGE_W, 38)
        self.text(42, 16, t("footer", issue=self.issue_no), 8, MUTED)
        self.text(PAGE_W - 42, 16, f"{self.page_no:02d}", 8, TEXT, align="right", weight="semibold")

    def header(self, kicker, title, page_fraction=""):
        c = self.canvas
        c.setFillColor(NAVY)
        c.rect(0, PAGE_H - 92, PAGE_W, 92, fill=1, stroke=0)
        c.setFillColor(GOLD)
        c.rect(0, PAGE_H - 100, PAGE_W, 8, fill=1, stroke=0)
        suffix = f" · {page_fraction}" if page_fraction else ""
        self.text(43, PAGE_H - 39, f"{kicker}{suffix}", 9, GOLD, weight="medium")
        self.text(43, PAGE_H - 66, title, 22, WHITE, weight="semibold")

    def finish(self):
        self.canvas.save()


# 로고 PNG를 지정한 높이로 원본 비율대로 그리고 실제 폭을 돌려준다.
# 파일이 없으면 0을 돌려주므로 호출부가 기존 텍스트 표기로 되돌아갈 수 있다.
def draw_logo(c, path, x, y, height, align="left"):
    if not path.exists():
        return 0
    image = ImageReader(str(path))
    native_width, native_height = image.getSize()
    width = native_width * height / native_height
    c.drawImage(image, x - width if align == "right" else x, y, width=width, height=height, mask="auto")
    return width


def draw_cover(report, summary, indicators):
    report.new_page()
    c = report.canvas
    c.setFillColor(GOLD)
    c.rect(0, PAGE_H - 8, PAGE_W, 8, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.rect(0, 0, PAGE_W, PAGE_H - 8, fill=1, stroke=0)

    report.text(PAGE_W - 42, PAGE_H - 58, report.issue_no, 18, WHITE, align="right", weight="semibold")
    report.text(PAGE_W - 42, PAGE_H - 78, issue_month(summary), 10, colors.HexColor("#C8D2DF"), align="right", weight="medium")

    text_width = PAGE_W - 86
    y = PAGE_H - 208
    report.text(43, y, "G L O B A L   I N V E S T M E N T   S I G N A L   M O N I T O R", 12, GOLD, weight="medium")
    # 제목은 잘라내면 뜻이 사라지므로, 여백을 넘지 않을 때까지 크기를 줄여서 통째로 싣는다.
    title_size = 30 if LANG == "en" else 36
    titles = [t("cover_title_1"), t("cover_title_2"), t("cover_title_3")]
    while title_size > 18 and any(
        c.stringWidth(title, report.fonts["semibold"], title_size) > text_width for title in titles
    ):
        title_size -= 1
    for index, title in enumerate(titles):
        y -= 56 if index == 0 else 45
        report.text(43, y, title, title_size, GOLD if index == 1 else WHITE, weight="semibold")

    y -= 42
    report.text(43, y, short_text_to_width(c, t("cover_line_1"), text_width, report.fonts["demilight"], 12), 12, WHITE)
    y -= 20
    report.text(43, y, short_text_to_width(c, t("cover_line_2"), text_width, report.fonts["demilight"], 12), 12, WHITE)

    y -= 45
    report.text(43, y, t("cover_indicator_heading"), 9, colors.HexColor("#C8D2DF"))
    y -= 29
    for item in indicators:
        c.setStrokeColor(GOLD)
        c.setLineWidth(1.2)
        c.circle(46, y + 4, 10, stroke=1, fill=0)
        report.text(46, y, str(item["no"]), 9, GOLD, align="center", weight="semibold")
        if LANG == "en":
            label = item.get("label_en") or item["label_ko"]
            description = INDICATOR_DESCRIPTION_EN.get(item["no"], item.get("description_ko", ""))
        else:
            label = item["label_ko"]
            description = item["description_ko"]
        # 라벨을 먼저 폭 안에 맞추고, 설명은 남은 자리만큼만 쓴다.
        # 예전에는 남은 폭에 하한 60pt를 걸어서, 라벨이 길면 설명이 라벨 위로 겹쳐 찍혔다.
        label = short_text_to_width(c, label, PAGE_W - 43 - 67, report.fonts["semibold"], 12)
        report.text(67, y - 1, label, 12, WHITE, weight="semibold")
        label_w = c.stringWidth(label, report.fonts["semibold"], 12)
        description_width = PAGE_W - 43 - (67 + label_w + 16)
        if description_width >= 50:
            description = short_text_to_width(c, description, description_width, report.fonts["demilight"], 8)
            report.text(PAGE_W - 43, y - 1, description, 8, colors.HexColor("#C8D2DF"), align="right")
        y -= 32

    c.setStrokeColor(colors.HexColor("#D6DEE9"))
    c.setLineWidth(0.7)
    c.line(43, 62, PAGE_W - 43, 62)
    if not draw_logo(c, KOTRA_LOGO_PATH, 43, 20, 34):
        report.text(43, 42, "kotra", 20, WHITE, weight="semibold")
        report.text(43, 29, "Korea Trade-Investment", 6.5, colors.HexColor("#C8D2DF"))
        report.text(43, 20, "Promotion Agency", 6.5, colors.HexColor("#C8D2DF"))
    if not draw_logo(c, INVEST_KOREA_LOGO_PATH, PAGE_W - 43, 21, 32, align="right"):
        report.text(PAGE_W - 43, 31, "Invest KOREA", 11, WHITE, align="right", weight="semibold")


def company_sort_key(row):
    return int(row.get("target_no") or 999)


def build_profiles(targets, tech_map):
    tech_rows = {row["company"]: row for row in tech_map.get("companies", [])}
    profiles = []
    for target in sorted(targets, key=company_sort_key):
        company = target["company"]
        tech = tech_rows.get(company, {})
        group = tech.get("technology_group", "")
        country = COUNTRY_BY_COMPANY.get(company, "")
        industry = DETAILED_INDUSTRY_BY_GROUP.get(group, tech.get("industry", ""))
        target_technology = tech.get("target_technology", "")
        if LANG == "en":
            country = COUNTRY_EN.get(country, country)
            industry = DETAILED_INDUSTRY_EN.get(group, industry)
            target_technology = tech.get("target_technology_en") or target_technology
        profiles.append(
            {
                **target,
                **tech,
                "target_no": target.get("target_no", tech.get("target_no")),
                "company": company,
                "country": country,
                "detailed_industry": industry,
                "target_technology": target_technology,
                "exempt_from_relevance": bool(tech.get("excluded_from_relevance")) or company in EXEMPT_COMPANIES,
            }
        )
    return profiles


PRESS_RELEASE_PATTERN = re.compile(
    r"press[\s_-]*releases?|news[\s_-]*releases?|media[\s_-]*releases?|pressreleases?|newsreleases?"
    r"|보도\s*자료|press[\s_-]*room|pressemitteilung|communiqu[eé]s?[\s_-]*de[\s_-]*presse"
    r"|comunicad[oa]s?[\s_-]*de[\s_-]*prensa",
    re.IGNORECASE,
)


def is_press_release(row):
    """수집 단계의 source_kind가 없는 과거 데이터도 출처명·URL로 공식 보도자료를 판별한다."""
    if not row or row.get("source_type") != "official":
        return False
    if row.get("is_press_release") is True:
        return True
    if row.get("source_kind"):
        return row.get("source_kind") == "press_release"
    haystack = " ".join(
        str(row.get(field) or "") for field in ("source", "official_source_url", "url")
    )
    return bool(PRESS_RELEASE_PATTERN.search(haystack))


def is_relevance_exempt(row):
    """분류 단계에서 유치필요 품목(기술) 관련성 검사를 생략한 행인지.

    이런 행에 타겟 기술 근거를 요구하면 분류 단계의 면제가 발행 단계에서 되살아난다.
    """
    return row.get("excluded_from_relevance") is True or row.get("technology_gate_decision") == "relevance_exempt"


def signal_supported(row):
    """요약 단계에서 본문을 읽고 '이 시그널의 근거가 실제로 있다'고 판정했는지.

    정확성 우선 원칙에 따라 판정 누락과 needs_review는 발행하지 않는다. 새 스키마의 세부 판정이
    있으면 기업 귀속·지표·선행성도 모두 참이어야 하고, 관련성 면제 대상이 아니면 타겟 기술
    근거도 함께 요구한다. 요약문의 분량·문체 문제는 근거 판정이 아니므로 여기서 보지 않는다.
    """
    if not row or row.get("ai_signal_supported") is not True:
        return False
    if row.get("ai_summary_quality") != "pass":
        return False
    target_technology_required = not is_relevance_exempt(row)
    required_fields = [
        "ai_entity_supported",
        "ai_indicator_supported",
        "ai_leading_indicator_supported",
    ]
    if target_technology_required:
        required_fields.append("ai_target_technology_supported")
    for field in required_fields:
        if row.get(field) is not True:
            return False
    stage = row.get("ai_event_stage")
    if row.get("investment_signal_no") is not None:
        allowed = stage in {"exploratory", "planned"} or (
            stage == "precursor" and str(row.get("investment_signal_no")) in {"1", "3", "4", "5"}
        )
    else:
        allowed = stage == "not_applicable"
    if not allowed:
        return False
    if not target_technology_required:
        return True
    reason = clean_text(row.get("ai_summary_reason")).lower()
    denial_patterns = (
        r"직접적? (?:연관성|연계).*(?:확인되지|없음)",
        r"직접 관련.*(?:근거.*제시되지|확인되지)",
        r"자체는 언급되지",
        r"not directly (?:related|linked)",
        r"no direct (?:evidence|link|connection|relevance)",
    )
    return not any(re.search(pattern, reason, re.IGNORECASE) for pattern in denial_patterns)


def sort_signal_rows(rows):
    def key(row):
        supported = 0 if signal_supported(row) else 1
        press = 0 if is_press_release(row) else 1
        official = 0 if row.get("source_type") == "official" else 1
        technology_score = -(row.get("technology_relevance_score") or row.get("relevance_score") or 0)
        signal_score = -(row.get("investment_signal_score") or 0)
        dt = parse_datetime(row.get("published_at"))
        timestamp = -dt.timestamp() if dt else 0
        return (supported, press, official, technology_score, signal_score, timestamp)

    return sorted(rows, key=key)


def index_investment_signals(rows):
    index = defaultdict(lambda: defaultdict(list))
    for row in rows:
        # 매트릭스의 켜진 칸은 '당월 포착된 시그널'을 뜻한다. 근거가 확인되지 않은 행이 칸을 켜면
        # 문서가 스스로 정의한 뜻과 어긋난다.
        if not signal_supported(row):
            continue
        company = row.get("company")
        try:
            no = int(row.get("investment_signal_no"))
        except Exception:
            continue
        index[company][no].append(row)
    for company in index:
        for no in index[company]:
            index[company][no] = sort_signal_rows(index[company][no])
    return index


def draw_matrix_table(report, profiles, signal_index, x, y_top, right=False):
    c = report.canvas
    table_w = 242
    header_h = 16
    row_h = 12.8
    index_x = x + 13
    name_x = x + 30
    signal_xs = [x + 152, x + 170, x + 188, x + 206, x + 224]

    c.setFillColor(NAVY)
    c.rect(x, y_top - header_h, table_w, header_h, fill=1, stroke=0)
    report.text(x + 7, y_top - 11, t("matrix_company"), 8, WHITE, weight="semibold")
    for idx, signal_no in enumerate(["①", "②", "③", "④", "⑤"]):
        report.text(signal_xs[idx] + 4, y_top - 10.5, signal_no, 7, WHITE, align="center", weight="semibold")

    y = y_top - header_h
    for profile in profiles:
        y -= row_h
        c.setStrokeColor(TABLE_LINE)
        c.setLineWidth(0.45)
        c.line(x, y, x + table_w, y)
        report.text(index_x, y + 3.7, str(profile["target_no"]), 6, colors.HexColor("#737C86"), align="center")
        report.text(name_x, y + 3.7, profile["company"], 6, TEXT)
        for idx in range(5):
            active = bool(signal_index.get(profile["company"], {}).get(idx + 1))
            c.setFillColor(GOLD if active else LIGHT)
            c.roundRect(signal_xs[idx], y + 3.0, 8.2, 8.2, 2, fill=1, stroke=0)


def draw_matrix(report, profiles, signal_index, summary, signal_rows):
    report.new_page()
    report.header("S I G N A L   M A T R I X", t("matrix_title"))
    signal_companies = [p for p in profiles if any(signal_index.get(p["company"], {}).values())]
    signal_company_names = {item["company"] for item in signal_companies}

    desc = t("matrix_desc", period=matrix_period_label(summary))
    report.wrapped(desc, 28, PAGE_H - 128, PAGE_W - 56, 8, colors.HexColor("#555F6E"), max_lines=2, line_gap=4, align="justify")

    draw_matrix_table(report, profiles[:39], signal_index, 25, PAGE_H - 145)
    draw_matrix_table(report, profiles[39:], signal_index, 281, PAGE_H - 145, right=True)

    y = 88
    c = report.canvas
    c.setFillColor(GOLD)
    c.roundRect(32, y + 9, 8, 8, 2, fill=1, stroke=0)
    legend_on = t("matrix_legend_on")
    report.text(45, y + 9, legend_on, 8, colors.HexColor("#596579"))
    legend_off_x = 45 + c.stringWidth(legend_on, report.fonts["demilight"], 8) + 18
    c.setFillColor(LIGHT)
    c.roundRect(legend_off_x, y + 9, 8, 8, 2, fill=1, stroke=0)
    report.text(legend_off_x + 13, y + 9, t("matrix_legend_off"), 8, colors.HexColor("#596579"))
    report.text(
        32,
        y - 6,
        short_text_to_width(c, t("matrix_indicators"), PAGE_W - 64, report.fonts["demilight"], 7),
        7,
        MUTED,
    )
    official_covered = {
        row.get("company")
        for row in signal_rows
        if row.get("company") and row.get("source_type") == "official"
    }
    if isinstance(summary.get("review_coverage"), list):
        official_covered = {item.get("company") for item in summary["review_coverage"] if item.get("status") == "reviewed"}
    reviewed_off = sum(
        1
        for profile in profiles
        if profile["company"] not in signal_company_names
        and profile["company"] in official_covered
    )
    insufficient = len(profiles) - len(signal_companies) - reviewed_off
    footnote = t(
        "matrix_footnote",
        on=len(signal_companies),
        reviewed_off=reviewed_off,
        insufficient=insufficient,
    )
    report.text(
        32,
        y - 24,
        short_text_to_width(c, footnote, PAGE_W - 64, report.fonts["extrabold"], 8),
        8,
        colors.HexColor("#4B5870"),
        weight="extrabold",
    )
    report.footer()


def source_line(row):
    source = row.get("source") or row.get("collector") or t("source_fallback")
    if is_press_release(row):
        source = f"{t('source_press_release')} · {source}"
    return short_text(f"{t('source_prefix')}  {source} {format_date(row.get('published_at'))}", 120)


def detail_text(row, limit=260):
    ai_summary = summary_plain_text(row)
    if ai_summary:
        return short_text(ai_summary, limit)

    evidence = ""
    snippets = row.get("evidence_snippets") or row.get("technology_evidence_snippets") or []
    if snippets:
        evidence = snippets[0]
    else:
        evidence = row.get("content_excerpt") or row.get("content_text") or ""
    title = clean_text(row.get("title"))
    evidence = clean_text(evidence)
    if evidence and title and title.lower() not in evidence.lower():
        return short_text(f"{title} - {evidence}", limit)
    return short_text(evidence or title, limit)


def expand_business_summary(row, text):
    return normalize_summary_text(text)


def business_text(rows):
    if not rows:
        return t("business_empty")
    row = sort_signal_rows(rows)[0]
    ai_summary = normalize_summary_text(summary_field(row, "ai_summary"))
    if ai_summary:
        return short_text(expand_business_summary(row, ai_summary), 950)
    return short_text(expand_business_summary(row, detail_text(row, 900)), 950)


def summary_line_count(report, row, width, size, max_lines):
    text = summary_plain_text(row) or detail_text(row, 560)
    font_name = report.fonts["demilight"]
    lines = wrap_text(report.canvas, text, width, font_name, size)
    return max(1, min(len(lines), max_lines))


def draw_summary_text(report, row, x, y, width, size=9.2, max_lines=2, line_gap=3):
    parts = summary_parts(row)
    line_height = size + line_gap
    if not parts:
        line_count = summary_line_count(report, row, width, size, max_lines)
        report.wrapped(detail_text(row, 560), x, y, width, size, TEXT, max_lines=max_lines, line_gap=line_gap)
        return line_count

    headline = parts["headline"]
    detail = parts["detail"]
    headline_font = report.fonts["semibold"]
    detail_font = report.fonts["demilight"]
    dash = " - " if detail else ""
    headline_width = report.canvas.stringWidth(headline, headline_font, size)
    dash_width = report.canvas.stringWidth(dash, detail_font, size)
    detail_width = report.canvas.stringWidth(detail, detail_font, size)

    if not detail or headline_width + dash_width + detail_width <= width or max_lines <= 1:
        available_detail_width = max(0, width - headline_width - dash_width)
        detail_to_draw = detail
        if detail and detail_width > available_detail_width:
            detail_lines = wrap_text(report.canvas, detail, available_detail_width, detail_font, size)
            detail_to_draw = detail_lines[0] if detail_lines else ""
        report.text(x, y, headline, size, TEXT, weight="semibold")
        cursor = x + headline_width
        if detail_to_draw:
            report.text(cursor, y, dash, size, colors.black, weight="demilight")
            report.text(cursor + dash_width, y, detail_to_draw, size, colors.black, weight="demilight")
        return 1

    report.wrapped(headline, x, y, width, size, TEXT, max_lines=1, line_gap=line_gap, weight="semibold")
    detail_lines = wrap_text(report.canvas, detail, width, detail_font, size)
    detail_text_value = f"- {detail}"
    if len(detail_lines) > max_lines - 1:
        detail_text_value = f"- {' '.join(detail_lines[: max_lines - 1])}"
    report.wrapped(detail_text_value, x, y - line_height, width, size, colors.black, max_lines=max_lines - 1, line_gap=line_gap, weight="demilight")
    return min(max_lines, 1 + len(detail_lines))


def best_business_row(company, relevant_rows, investment_rows, all_signal_rows):
    candidates = [row for row in relevant_rows if row.get("company") == company and signal_supported(row)]
    if not candidates:
        candidates = [row for row in investment_rows if row.get("company") == company and signal_supported(row)]
    if not candidates:
        candidates = [
            row
            for row in all_signal_rows
            if row.get("company") == company
            and row.get("source_type") == "official"
            and signal_supported(row)
        ]
    return sort_signal_rows(candidates)[0] if candidates else None


def draw_badge(report, x, y, value, active):
    c = report.canvas
    c.setFillColor(NAVY if active else colors.HexColor("#D8DADF"))
    c.roundRect(x, y - 9, 16, 16, 3, fill=1, stroke=0)
    report.text(x + 8, y - 4.5, str(value), 9, WHITE, align="center", weight="semibold")


def draw_industry_pill(report, x, y, max_width, text, color):
    """산업 라벨 알약. 글자를 먼저 폭에 맞춘 뒤 알약을 그 글자에 맞춰 그린다.

    예전에는 알약 폭만 132pt로 자르고 글자는 원문 그대로 찍어서, 영문 산업명처럼
    긴 라벨이 알약 밖으로 튀어나오고 뒤따르는 국가명과 겹쳤다.
    """
    text = short_text_to_width(report.canvas, text, max_width - 18, report.fonts["semibold"], 9)
    if not text:
        return 0
    pill_width = report.canvas.stringWidth(text, report.fonts["semibold"], 9) + 18
    report.canvas.setFillColor(LIGHT)
    report.canvas.roundRect(x, y - 7, pill_width, 18, 3, fill=1, stroke=0)
    report.text(x + 9, y - 2, text, 9, color, weight="semibold")
    return pill_width


def draw_target_marker(c, x, y, size=11):
    if TARGET_EMOJI_PATH.exists():
        c.drawImage(
            ImageReader(str(TARGET_EMOJI_PATH)),
            x - size / 2,
            y - size / 2,
            width=size,
            height=size,
            mask="auto",
        )
        return

    c.setFillColor(colors.HexColor("#F45E7A"))
    c.circle(x, y, 4.4, fill=1, stroke=0)
    c.setFillColor(colors.HexColor("#F4FBFA"))
    c.circle(x, y, 2.9, fill=1, stroke=0)
    c.setFillColor(colors.HexColor("#0A7C72"))
    c.circle(x, y, 1.45, fill=1, stroke=0)


DETAIL_BOX_TOP = PAGE_H - 114
DETAIL_BOX_GAP = 16
DETAIL_BOTTOM_MARGIN = 56
DETAIL_FIRST_SIGNAL_BASELINE_OFFSET = 64
DETAIL_SIGNAL_BOTTOM_PAD = 24
SIGNAL_LABEL_TOP_OFFSET = 7
SIGNAL_LABEL_TO_BODY = 23
SIGNAL_BODY_SIZE = 8.8
SIGNAL_BODY_GAP = 1.6
SIGNAL_SOURCE_SIZE = 7.1
SIGNAL_SOURCE_GAP = 1.0
SIGNAL_SOURCE_BOTTOM_OFFSET = 2.5
SIGNAL_EMPTY_CONTENT_BOTTOM_OFFSET = 14
SIGNAL_CONTENT_TO_SEPARATOR = 10
SIGNAL_SEPARATOR_TO_NEXT_LABEL_TOP = 6
BUSINESS_MIN_BOX_H = 88
BUSINESS_MAX_BOX_H = 136
BUSINESS_HEADER_TOP_PAD = 25
BUSINESS_BODY_TOP_PAD = 44
BUSINESS_SOURCE_GAP = 8
BUSINESS_SOURCE_BOTTOM_PAD = 15
BUSINESS_BODY_SIZE = 9.0
BUSINESS_BODY_LINE_GAP = 1.35
BUSINESS_BODY_MAX_LINES = 5
# 상세 페이지가 쓸 수 있는 (시그널 본문 줄 수, 사업현황 본문 줄 수) 조합.
# 작은 것부터 시도해 페이지에 들어가는 마지막 조합을 쓴다. 첫 항목은 기존 값이라 최소 보장선이 된다.
DETAIL_GROWTH_STEPS = (
    (2, 5),
    (3, 5),
    (3, 6),
    (4, 6),
    (4, 7),
    (5, 7),
    (5, 8),
    (6, 8),
    (6, 9),
)


def signal_body_line_count(report, row, width, max_lines):
    body_width = width - 64
    return summary_line_count(report, row, body_width, SIGNAL_BODY_SIZE, max_lines)


def signal_content_bottom_offset(report, rows, width, max_lines):
    if not rows:
        return SIGNAL_EMPTY_CONTENT_BOTTOM_OFFSET
    line_count = signal_body_line_count(report, rows[0], width, max_lines)
    return (
        SIGNAL_LABEL_TO_BODY
        + (line_count * (SIGNAL_BODY_SIZE + SIGNAL_BODY_GAP))
        + SIGNAL_SOURCE_GAP
        + SIGNAL_SOURCE_BOTTOM_OFFSET
    )


def signal_box_layout(report, rows_by_signal, width, max_lines):
    y_offset = DETAIL_FIRST_SIGNAL_BASELINE_OFFSET
    positions = {}
    for no in range(1, 6):
        positions[no] = DETAIL_BOX_TOP - y_offset
        content_offset = signal_content_bottom_offset(report, rows_by_signal.get(no, []), width, max_lines)
        if no < 5:
            y_offset += (
                content_offset
                + SIGNAL_CONTENT_TO_SEPARATOR
                + SIGNAL_SEPARATOR_TO_NEXT_LABEL_TOP
                + SIGNAL_LABEL_TOP_OFFSET
            )
        else:
            y_offset += content_offset + DETAIL_SIGNAL_BOTTOM_PAD
    return positions, y_offset


def fitted_business_body(report, text, width, max_lines=BUSINESS_BODY_MAX_LINES):
    font_name = report.fonts["demilight"]
    size = BUSINESS_BODY_SIZE
    line_gap = BUSINESS_BODY_LINE_GAP
    # 박스에 안 들어가는 요약은 문장 단위로 끊어 마지막 문장이 완결되게 한다.
    text = fit_sentences(report.canvas, text, width, font_name, size, max_lines)
    lines = wrap_text(report.canvas, text, width, font_name, size)
    visible = lines[:max_lines]
    if len(lines) > max_lines and visible:
        visible[-1] = short_text_to_width(report.canvas, f"{visible[-1]}...", width, font_name, size)
    return {"lines": visible, "size": size, "line_gap": line_gap, "truncated": len(lines) > max_lines}


def business_box_metrics(report, text, width, max_lines=BUSINESS_BODY_MAX_LINES, extra_top=0):
    body_width = width - 32
    body = fitted_business_body(report, text, body_width, max_lines=max_lines)
    line_count = max(1, len(body["lines"]))
    line_height = body["size"] + body["line_gap"]
    height = (
        BUSINESS_BODY_TOP_PAD
        + extra_top
        + (line_count * line_height)
        + BUSINESS_SOURCE_GAP
        + 8
        + BUSINESS_SOURCE_BOTTOM_PAD
    )
    # 줄 수를 늘려 잡은 만큼, 그리고 타겟품목이 아랫줄로 내려간 만큼 박스 높이 상한도 같이 올린다.
    ceiling = BUSINESS_MAX_BOX_H + extra_top + max(0, max_lines - BUSINESS_BODY_MAX_LINES) * line_height
    body["height"] = max(BUSINESS_MIN_BOX_H + extra_top, min(ceiling, height))
    return body


TARGET_WRAP_HEIGHT = 15


def business_target_layout(report, profile, x, width):
    """청록 박스 머리줄 배치를 미리 계산한다.

    타겟품목 텍스트가 라벨 옆 한 줄에 다 들어가면 예전처럼 옆에 붙이고(국문은 항상 여기),
    안 들어가면 잘라내는 대신 박스를 한 줄 키워 아랫줄에 통째로 싣는다.
    """
    label, text = target_section_for_profile(profile)
    if not text:
        return {"text": "", "wrapped": False, "extra_top": 0}
    c = report.canvas
    heading = t("business_heading")
    heading_w = c.stringWidth(heading, report.fonts["semibold"], 8.5) + 0.85 * len(heading)
    label_x = x + 16 + heading_w + 18
    label_w = c.stringWidth(label, report.fonts["semibold"], 8.5) + 38
    value_x = label_x + label_w + 9
    value_width = (x + width - 16) - value_x
    fits = c.stringWidth(text, report.fonts["semibold"], 9.5) <= value_width
    return {
        "label": label,
        "text": text,
        "label_x": label_x,
        "label_w": label_w,
        "value_x": value_x,
        "value_width": value_width,
        "wrapped": not fits,
        "extra_top": 0 if fits else TARGET_WRAP_HEIGHT,
    }


def target_section_for_profile(profile):
    if profile.get("exempt_from_relevance"):
        return "", ""
    target_text = str(profile.get("target_technology") or "").strip()
    if not target_text:
        return "", ""
    is_technology = normalize_company_key(profile.get("company")) in TARGET_TECH_LABEL_COMPANIES
    return t("target_tech") if is_technology else t("target_item"), target_text


def draw_signal_row(report, no, rows, x, y, width, max_lines=2, draw_separator=True):
    active = bool(rows)
    c = report.canvas
    draw_badge(report, x, y, no, active)
    label_x = x + 31
    label = SIGNAL_DESCRIPTIONS_EN[no] if LANG == "en" else SIGNAL_DESCRIPTIONS[no]
    # 알약은 폭 상한이 있으므로 글자를 먼저 그 안에 맞춘다. 예전에는 알약만 잘리고 글자는 그대로 나가서 밖으로 튀어나왔다.
    label = short_text_to_width(report.canvas, label, width - 190 - 16, report.fonts["semibold"], 7.6)
    label_w = report.canvas.stringWidth(label, report.fonts["semibold"], 7.6) + 14
    c.setFillColor(LIGHT)
    c.roundRect(label_x, y - 9, label_w, 16, 3, fill=1, stroke=0)
    report.text(label_x + 8, y - 4, label, 7.6, colors.HexColor("#56687B"), weight="semibold")

    if not active:
        empty_x = label_x + label_w + 18
        empty_text = short_text_to_width(
            report.canvas, t("no_signal"), x + width - 22 - empty_x, report.fonts["demilight"], 10
        )
        report.text(empty_x, y - 4, empty_text, 10, colors.HexColor("#B5B9BF"))
        report.text(x + width - 12, y - 4, "-", 10, colors.HexColor("#B5B9BF"), align="right")
        if draw_separator:
            c.setStrokeColor(BOX_LINE)
            separator_y = y - SIGNAL_EMPTY_CONTENT_BOTTOM_OFFSET - SIGNAL_CONTENT_TO_SEPARATOR
            c.line(x, separator_y, x + width, separator_y)
        return None

    row = rows[0]
    body_y = y - SIGNAL_LABEL_TO_BODY
    line_count = draw_summary_text(
        report,
        row,
        label_x,
        body_y,
        width - 64,
        SIGNAL_BODY_SIZE,
        max_lines=max_lines,
        line_gap=SIGNAL_BODY_GAP,
    )
    source_y = body_y - ((SIGNAL_BODY_SIZE + SIGNAL_BODY_GAP) * line_count) - SIGNAL_SOURCE_GAP
    source_text = short_text_to_width(report.canvas, source_line(row), width - 64, report.fonts["demilight"], SIGNAL_SOURCE_SIZE)
    report.text(label_x, source_y, source_text, SIGNAL_SOURCE_SIZE, MUTED)
    if draw_separator:
        separator_y = source_y - SIGNAL_SOURCE_BOTTOM_OFFSET - SIGNAL_CONTENT_TO_SEPARATOR
        c.setStrokeColor(BOX_LINE)
        c.line(x, separator_y, x + width, separator_y)
    return None


def draw_detail_page(report, profile, signal_index, relevant_rows, investment_rows, all_signal_rows, idx, total):
    report.new_page()
    report.header("C O M P A N Y   S I G N A L S", t("detail_title"), f"{idx}/{total}")
    company = profile["company"]
    rows_by_signal = signal_index.get(company, {})
    x = 30
    width = PAGE_W - 60
    signal_width = width - 38
    business_row = best_business_row(company, relevant_rows, investment_rows, all_signal_rows)
    business_body = business_text([business_row] if business_row else [])
    target_layout = business_target_layout(report, profile, x, width)

    # 페이지 아래가 비어 있는데 2줄에서 끊을 이유가 없다. 들어가는 가장 큰 조합을 고른다.
    max_lines, signal_positions, top_h, business_layout = None, None, None, None
    for signal_lines, business_lines in DETAIL_GROWTH_STEPS:
        positions, candidate_top_h = signal_box_layout(report, rows_by_signal, signal_width, signal_lines)
        layout = business_box_metrics(
            report, business_body, width, max_lines=business_lines, extra_top=target_layout["extra_top"]
        )
        used = candidate_top_h + DETAIL_BOX_GAP + layout["height"]
        if max_lines is not None and DETAIL_BOX_TOP - used < DETAIL_BOTTOM_MARGIN:
            break
        max_lines, signal_positions, top_h, business_layout = signal_lines, positions, candidate_top_h, layout

    bottom_h = business_layout["height"]
    top_y = DETAIL_BOX_TOP - top_h
    bottom_y = top_y - DETAIL_BOX_GAP - bottom_h
    c = report.canvas

    c.setStrokeColor(BOX_LINE)
    c.setLineWidth(0.9)
    c.setFillColor(WHITE)
    c.roundRect(x, top_y, width, top_h, 10, fill=1, stroke=1)

    header_y = DETAIL_BOX_TOP - 29
    report.text(x + 17, header_y, company, 14, TEXT, weight="semibold")
    name_w = report.canvas.stringWidth(company, report.bold_font, 14)
    industry_x = min(x + 17 + name_w + 14, x + 250)
    country_text = profile.get("country", "")
    country_w = report.canvas.stringWidth(country_text, report.fonts["semibold"], 9) if country_text else 0
    industry_limit = min(190, (x + width - 17) - country_w - 12 - industry_x)
    industry_w = draw_industry_pill(
        report, industry_x, header_y, industry_limit, profile.get("detailed_industry", ""), colors.HexColor("#56687B")
    )
    report.text(industry_x + industry_w + 10, header_y - 2, country_text, 9, colors.HexColor("#B1B6BE"), weight="semibold")

    c.setStrokeColor(colors.black)
    c.setLineWidth(1)
    c.line(x + 17, header_y - 18, x + width - 17, header_y - 18)

    for no in range(1, 6):
        draw_signal_row(
            report,
            no,
            rows_by_signal.get(no, []),
            x + 19,
            signal_positions[no],
            signal_width,
            max_lines=max_lines,
            draw_separator=no < 5,
        )

    c.setStrokeColor(TEAL_LINE)
    c.setFillColor(TEAL_BG)
    c.roundRect(x, bottom_y, width, bottom_h, 10, fill=1, stroke=1)
    top = bottom_y + bottom_h
    header_y = top - 25
    heading = t("business_heading")
    report.spaced_text(x + 16, header_y, heading, 8.5, colors.HexColor("#087A70"), weight="semibold", char_space=0.85)
    if target_layout["text"]:
        c.setFillColor(colors.HexColor("#DDF0EE"))
        c.roundRect(target_layout["label_x"], top - 32, target_layout["label_w"], 20, 3, fill=1, stroke=0)
        draw_target_marker(c, target_layout["label_x"] + 13, header_y + 2)
        report.text(
            target_layout["label_x"] + 25, header_y, target_layout["label"], 8.5, colors.HexColor("#087A70"), weight="semibold"
        )
        if target_layout["wrapped"]:
            # 라벨 옆에 안 들어가는 타겟품목은 잘라내지 않고 박스 폭 전체를 쓰는 아랫줄에 싣는다.
            wrapped_text = short_text_to_width(c, target_layout["text"], width - 32, report.fonts["semibold"], 9.5)
            report.text(
                x + 16, header_y - TARGET_WRAP_HEIGHT, wrapped_text, 9.5, colors.HexColor("#087A70"), weight="semibold"
            )
        else:
            report.text(
                target_layout["value_x"], header_y, target_layout["text"], 9.5, colors.HexColor("#087A70"), weight="semibold"
            )

    body_y = top - BUSINESS_BODY_TOP_PAD - target_layout["extra_top"]
    report.set_font(business_layout["size"], TEXT, weight="demilight")
    line_height = business_layout["size"] + business_layout["line_gap"]
    for line in business_layout["lines"]:
        report.canvas.drawString(x + 16, body_y, line)
        body_y -= line_height
    source_y = max(bottom_y + BUSINESS_SOURCE_BOTTOM_PAD, body_y - BUSINESS_SOURCE_GAP)
    source_width = width - 32
    if business_row:
        source_text = short_text_to_width(report.canvas, source_line(business_row), source_width, report.fonts["demilight"], 8)
        report.text(x + 16, source_y, source_text, 8, MUTED)
    else:
        report.text(x + 16, source_y, t("source_empty"), 8, MUTED)
    report.footer()


ITEM_SECTION_TOP = PAGE_H - 114
ITEM_SECTION_FIRST_TOP = PAGE_H - 158
ITEM_SECTION_BOTTOM = 56
ITEM_CARD_GAP = 14
ITEM_CARD_TITLE_TOP = 29
ITEM_CARD_TITLE_TO_RULE = 18
ITEM_RULE_TO_TARGET = 21
ITEM_TARGET_TO_TREND = 24
ITEM_TREND_LABEL_TO_BODY = 19
ITEM_BODY_SIZE = 8.8
ITEM_BODY_GAP = 2.0
ITEM_BODY_MAX_LINES = 4
ITEM_BODY_TO_SOURCE = 11
ITEM_SOURCE_SIZE = 7.1
ITEM_CARD_BOTTOM_PAD = 16
ITEM_LABEL_SIZE = 7.6
ITEM_LABEL_COLOR = colors.HexColor("#56687B")


def build_item_trend_entries(profiles, signal_index, relevant_rows):
    """5대 시그널 미포착 + 타겟 품목·기술 연관 사업동향 포착 기업을 기업 단위로 모은다."""
    entries = []
    for profile in profiles:
        company = profile["company"]
        if any(signal_index.get(company, {}).values()):
            continue
        # 이 카드의 존재 이유가 '타겟 품목·기술과 직접 연계된 사업동향'이므로,
        # 그 연계가 확인되지 않은 행으로는 카드를 만들지 않는다.
        candidates = [row for row in relevant_rows if row.get("company") == company and signal_supported(row)]
        if not candidates:
            continue
        if not str(profile.get("target_technology") or "").strip():
            continue
        entries.append({"profile": profile, "row": sort_signal_rows(candidates)[0]})
    return entries


def item_trend_body(report, row, width, size, max_lines):
    """카드 본문은 명사구 캡션이 아니라 완결된 서술 문장으로 채운다.

    요약문을 문장 단위로 끊어 max_lines 안에 들어가는 데까지만 담기 때문에,
    문장 중간에서 '...'로 잘리지 않고 '무엇을 했다 / 하고 있다'로 끝난다.
    """
    font_name = report.fonts["demilight"]
    text = normalize_summary_text(summary_field(row, "ai_summary")) or normalize_summary_text(detail_text(row, 400))
    body = fit_sentences(report.canvas, text, width, font_name, size, max_lines)
    if not body:
        return "", 1
    return body, max(1, min(max_lines, len(wrap_text(report.canvas, body, width, font_name, size))))


def item_card_layout(report, entry, width):
    body_width = width - 34
    _, line_count = item_trend_body(report, entry["row"], body_width, ITEM_BODY_SIZE, ITEM_BODY_MAX_LINES)
    rule_offset = ITEM_CARD_TITLE_TOP + ITEM_CARD_TITLE_TO_RULE
    target_offset = rule_offset + ITEM_RULE_TO_TARGET
    trend_offset = target_offset + ITEM_TARGET_TO_TREND
    body_offset = trend_offset + ITEM_TREND_LABEL_TO_BODY
    source_offset = body_offset + ((line_count - 1) * (ITEM_BODY_SIZE + ITEM_BODY_GAP)) + ITEM_BODY_TO_SOURCE
    return {
        "body_width": body_width,
        "rule_offset": rule_offset,
        "target_offset": target_offset,
        "trend_offset": trend_offset,
        "body_offset": body_offset,
        "source_offset": source_offset,
        "height": source_offset + ITEM_CARD_BOTTOM_PAD,
    }


def draw_label_pill(report, x, y, label):
    c = report.canvas
    pill_width = c.stringWidth(label, report.fonts["semibold"], ITEM_LABEL_SIZE) + 14
    c.setFillColor(LIGHT)
    c.roundRect(x, y - 5, pill_width, 15, 3, fill=1, stroke=0)
    report.text(x + 7, y, label, ITEM_LABEL_SIZE, ITEM_LABEL_COLOR, weight="semibold")
    return pill_width


def draw_item_card(report, entry, layout, x, top, width, month_label):
    c = report.canvas
    profile = entry["profile"]
    row = entry["row"]
    company = profile["company"]

    c.setStrokeColor(BOX_LINE)
    c.setLineWidth(0.9)
    c.setFillColor(WHITE)
    c.roundRect(x, top - layout["height"], width, layout["height"], 10, fill=1, stroke=1)

    header_y = top - ITEM_CARD_TITLE_TOP
    report.text(x + 17, header_y, company, 13, TEXT, weight="semibold")
    name_w = c.stringWidth(company, report.bold_font, 13)
    industry_text = profile.get("detailed_industry", "")
    country_text = profile.get("country", "")
    country_w = c.stringWidth(country_text, report.fonts["semibold"], 9) if country_text else 0
    if industry_text:
        industry_x = min(x + 17 + name_w + 14, x + 250)
        industry_limit = min(190, (x + width - 17) - country_w - 12 - industry_x)
        draw_industry_pill(report, industry_x, header_y, industry_limit, industry_text, ITEM_LABEL_COLOR)
    report.text(x + width - 17, header_y - 2, country_text, 9, GREY_TEXT, align="right", weight="semibold")

    rule_y = top - layout["rule_offset"]
    c.setStrokeColor(colors.black)
    c.setLineWidth(1)
    c.line(x + 17, rule_y, x + width - 17, rule_y)

    target_y = top - layout["target_offset"]
    target_pill_w = draw_label_pill(report, x + 17, target_y, t("item_target_label"))
    target_x = x + 17 + target_pill_w + 10
    target_text = short_text_to_width(
        c, str(profile.get("target_technology") or ""), x + width - 17 - target_x, report.fonts["semibold"], 9.5
    )
    report.text(target_x, target_y, target_text, 9.5, TEXT, weight="semibold")

    draw_label_pill(report, x + 17, top - layout["trend_offset"], t("item_trend_label", month=month_label))

    body, _ = item_trend_body(report, row, layout["body_width"], ITEM_BODY_SIZE, ITEM_BODY_MAX_LINES)
    report.wrapped(
        body,
        x + 17,
        top - layout["body_offset"],
        layout["body_width"],
        ITEM_BODY_SIZE,
        colors.black,
        max_lines=ITEM_BODY_MAX_LINES,
        line_gap=ITEM_BODY_GAP,
        weight="demilight",
    )
    source_text = short_text_to_width(c, source_line(row), layout["body_width"], report.fonts["demilight"], ITEM_SOURCE_SIZE)
    report.text(x + 17, top - layout["source_offset"], source_text, ITEM_SOURCE_SIZE, MUTED)


def paginate_item_cards(report, entries, width):
    pages = []
    current = []
    cursor = ITEM_SECTION_FIRST_TOP
    for entry in entries:
        layout = item_card_layout(report, entry, width)
        if current and cursor - layout["height"] < ITEM_SECTION_BOTTOM:
            pages.append(current)
            current = []
            cursor = ITEM_SECTION_TOP
        current.append({"entry": entry, "layout": layout, "top": cursor})
        cursor -= layout["height"] + ITEM_CARD_GAP
    if current:
        pages.append(current)
    return pages


def draw_item_trends(report, profiles, signal_index, relevant_rows, summary):
    entries = build_item_trend_entries(profiles, signal_index, relevant_rows)
    if not entries:
        return {"item_count": 0, "company_count": 0, "pages": 0}

    x = 30
    width = PAGE_W - 60
    month_label = report_month_label(summary)
    pages = paginate_item_cards(report, entries, width)
    note = t("item_note", month=month_label)
    for index, page in enumerate(pages, start=1):
        report.new_page()
        report.header("I T E M   T R E N D S", t("item_title"), f"{index}/{len(pages)}")
        if index == 1:
            report.wrapped(note, 28, PAGE_H - 128, PAGE_W - 56, 8, colors.HexColor("#555F6E"), max_lines=2, line_gap=4, align="justify")
        for placed in page:
            draw_item_card(report, placed["entry"], placed["layout"], x, placed["top"], width, month_label)
        report.footer()

    return {
        "item_count": len({entry["profile"].get("technology_group") for entry in entries}),
        "company_count": len(entries),
        "pages": len(pages),
    }


def build_report(args):
    set_language(args.lang)
    targets = load_json(args.targets, [])
    tech_map = load_json(args.technology_map, {"companies": []})
    signals = load_json(args.signals, [])
    summary = override_summary_period(load_json(args.summary, {}), args.from_date, args.to_date)
    relevant = load_json(args.relevant, [])
    investment_signals = load_json(args.investment_signals, [])
    investment_summary = load_json(args.investment_summary, {})
    indicators = load_json(args.indicator_config, {}).get("indicators", [])

    signals = filter_rows_by_report_period(signals, summary)
    relevant = filter_rows_by_report_period(relevant, summary)
    investment_signals = filter_rows_by_report_period(investment_signals, summary)
    investment_signals = filter_ignored_signals(investment_signals, parse_ignored_signal_keys(args.ignored_signals))

    profiles = build_profiles(targets, tech_map)
    signal_index = index_investment_signals(investment_signals)
    detail_profiles = [profile for profile in profiles if any(signal_index.get(profile["company"], {}).values())]

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fonts = register_fonts(args.font)
    issue_number = re.sub(r"\D+", "", str(args.issue_number or DEFAULT_ISSUE_NUMBER)) or DEFAULT_ISSUE_NUMBER
    report = SlideReport(out_path, fonts, issue_number)

    draw_cover(report, summary, indicators)
    draw_matrix(report, profiles, signal_index, summary, signals)
    total_details = len(detail_profiles)
    for idx, profile in enumerate(detail_profiles, start=1):
        draw_detail_page(report, profile, signal_index, relevant, investment_signals, signals, idx, total_details)
    item_trends = draw_item_trends(report, profiles, signal_index, relevant, summary)

    report.finish()
    print(
        json.dumps(
            {
                "output": str(out_path),
                "lang": LANG,
                "pages": report.page_no,
                "company_count": len(profiles),
                "detail_company_count": total_details,
                "item_trend_item_count": item_trends["item_count"],
                "item_trend_company_count": item_trends["company_count"],
                "item_trend_pages": item_trends["pages"],
                "investment_signal_count": investment_summary.get("investment_signal_count", len(investment_signals)),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--targets", default="data/target_companies.json")
    parser.add_argument("--technology-map", default="data/company_technology_map.json")
    parser.add_argument("--signals", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--relevant", required=True)
    parser.add_argument("--relevance-summary", required=False)
    parser.add_argument("--investment-signals", required=True)
    parser.add_argument("--investment-summary", required=True)
    parser.add_argument("--indicator-config", required=True)
    parser.add_argument("--font", required=True)
    parser.add_argument("--issue-number", default=DEFAULT_ISSUE_NUMBER)
    parser.add_argument("--lang", default="ko", choices=["ko", "en"])
    parser.add_argument("--ignored-signals", default="")
    parser.add_argument("--from-date", default="")
    parser.add_argument("--to-date", default="")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    build_report(args)


if __name__ == "__main__":
    main()
