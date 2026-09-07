# Gemini 무료 API 보고서 실행

기존 `collect-company-signals.yml` 실행을 Gemini 기사별 분석으로 변경했다. `OPENAI_API_KEY`를 사용하거나 유료 모델로 전환하지 않는다. 키워드 필터 탈락분을 포함한 기간 내 모든 기사를 검토하며, 기사당 한 번의 요청으로 투자지표 5개와 사업동향을 판단한다. 검증된 한·영 문안은 기존 PDF 생성기로 출력한다.

## 최초 설정

- GitHub Actions Secret: `GEMINI_API_KEY` (등록 확인 완료).
- Google AI Studio에서 키가 속한 프로젝트가 **결제를 연결하지 않은 Free Tier**인지 확인한다. 그 다음 GitHub Actions **Variable** `GEMINI_FREE_TIER_CONFIRMED`를 `true`로 설정한다. 이 값이 없으면 크롤링·API 호출 전에 종료한다.
- 기본 모델은 `gemini-3.1-flash-lite`다. 2026-09-07 Google 공식 가격표의 Standard Free Tier 대상이며 실제 생성 요청으로 검증했다. Actions Variable `GEMINI_MODEL`로 다른 모델을 지정할 수 있고, Flash·Flash-Lite 계열 ID만 허용한다(오타로 종량 모델을 호출하지 못하게). 값을 비우면 기본값으로 돌아간다. 2026-09-07 가격표 기준 `gemini-3.5-flash-lite`, `gemini-3.5-flash`도 Free Tier "Free of charge"로 표시되나, 생성 요청의 실제 응답·용량은 실행으로 확인해야 한다(어제 `gemini-3.8-flash`·`gemini-3.7-flash`는 503, `gemini-2.5-flash`는 404였다).
- 무료 모델이라도 유료 프로젝트 키로 호출하면 과금될 수 있다. 코드나 API 키 이름, 모델 이름으로 결제 상태를 판별할 수 없다. 결제를 연결할 경우 확인 변수를 해제하고 재검토해야 한다.
- 무료 서비스에는 입력의 제품 개선 사용 조건이 있다. 공개 기사와 분석에 필요한 기업·기술·지표 기준을 전송한다. 비공개 내부 전략 자료는 입력하지 않는다.

공식 근거: [가격표](https://ai.google.dev/gemini-api/docs/pricing), [할당량](https://ai.google.dev/gemini-api/docs/rate-limits), [구조화 응답](https://ai.google.dev/gemini-api/docs/structured-output).

## 실행과 이어가기

1. GitHub Actions에서 `collect-company-signals`를 실행한다. 이번 변경을 시험할 때는 `feat/local-monthly-report` 브랜치를 선택한다. 날짜를 비우면 직전 달을 사용한다.
2. 기본적으로 저장된 같은 기간 원문을 재사용한다. 처음에는 크롤링한다. `refresh=true`는 원문을 새로 수집한다. 이어가기에는 `false`를 유지한다.
3. 한 번 실행할 때 새 API 요청은 기본 최대 40건, 요청 사이 대기는 15초다. Actions Variables `GEMINI_MAX_REQUESTS`(1~200), `GEMINI_DELAY_MS`(15000~60000)로 조절할 수 있다. 실제 할당량을 보장하는 수치는 아니다. 새 모델을 시험할 때는 `GEMINI_MODEL`을 설정하고 `GEMINI_MAX_REQUESTS`를 2~3으로 낮춰 용량·응답을 먼저 확인한 뒤 40으로 되돌린다. 모델을 바꾸면 캐시 식별자가 바뀌어 앞선 판정은 재사용되지 않는다.
4. 429(한도 초과), 서버 오류, 실행당 요청 상한에서는 저장 후 멈춘다. GitHub 실행은 실패로 표시되며 실행 요약과 artifact의 `status.json`에 `paused`와 진행 건수가 남는다. **할당량 회복 후 같은 날짜로 다시 실행**하면 남은 기사부터 진행한다. 자동 예약 재실행은 아직 연결하지 않았다.
5. 모든 기사의 응답이 검증된 후 한·영 PDF와 대시보드 JSON을 함께 커밋한다. 성공한 실행의 `monthly-report-pdfs-*` artifact에서도 PDF를 다운로드할 수 있다. 대기·오류 중에는 기존 발행물을 교체하지 않는다.

원문과 판정 캐시는 GitHub Actions Cache에 보관한다. 캐시는 영구 저장소가 아니므로 삭제·퇴거되면 재수집/재분석이 필요하다. 실행마다 `gemini-report-*` artifact에도 30일 보관한다. 이 artifact의 복원은 자동화하지 않았다. 새 실행이 기존 실행을 취소하지 않도록 같은 브랜치에서는 순서대로 처리한다. 진행 중 사용자가 강제 취소하면 마지막 캐시 저장 이후 결과는 유실될 수 있다.

## 판정과 검증 범위

- 원문·기업 기술·판정 정책·모델이 바뀌면 캐시 식별자가 바뀐다.
- 후보 누락, 잘못된 인용, 불완전 JSON, 출력 토큰 초과, 인증 오류는 보고서 발행을 차단한다. 이미 완료한 기사의 캐시는 저장한다.
- `needs_review`는 시그널 없음으로 단정하지 않으며 수집·검토 부족으로 보고한다. 정확한 인용 일치는 의미 판단의 정확성을 보장하지 않는다.
- `npm test`는 기존 계약과 Gemini 요청·재개·차단 동작을 검증한다. 모의 응답 테스트이며 실제 Gemini 판정 품질을 검증한 것은 아니다.
- Vercel은 설정된 `GITHUB_REF`의 워크플로를 실행한다. 기본값 `main`에서는 브랜치 변경이 아직 반영되지 않는다. 이 변경만으로 기존 Vercel PDF의 배포 시점 데이터 문제가 해결되는 것은 아니다. 이번 범위는 Actions의 Gemini 분석·PDF 생성이며 배포와 다운로드 경로 개선은 별도다.

로컬 실행에는 `GEMINI_API_KEY`, `GEMINI_FREE_TIER_CONFIRMED=true`, `REPORT_FROM_DATE`, `REPORT_TO_DATE` 및 Python ReportLab 환경이 필요하다. 직원 PC에서 실행할 필요는 없다. `npm run report:gemini`는 개발자용 진입점이다. 기존 `report:local` 경로도 유지한다.

## 실제 연결 검증 (2026-09-07)

교체된 키가 별도 결제 미연결 Free Tier 프로젝트의 키임을 사용자에게 확인한 뒤 `GEMINI_FREE_TIER_CONFIRMED=true`를 등록했다. `gemini-3.8-flash`와 `gemini-3.7-flash`는 반복된 503 capacity 응답, `gemini-2.5-flash`는 모델 목록에는 있었지만 생성 요청에서 404를 반환했다. 최종 모델은 실제 응답을 검증한 `gemini-3.1-flash-lite`다.

[검증 실행](https://github.com/KOTRA-InvestKOREA-HT/monthly_global_signal_monitoring/actions/runs/34057393153)에서 기간 내 294개 기사 중 최초 2건을 검증·저장했고, 재실행은 기존 2건을 재사용한 뒤 다음 2건을 저장했다 (`requests=2`, `cached=2`, `completed=4`). 각 기사는 6개 후보 판정을 포함한다. 2건 제한에 따른 종료 코드 75는 의도된 일시정지이며 실제 검증 오류와 구분해야 한다. 검증 종료 후 저장소의 요청 상한 변수를 운영 기본값 40으로 복구했다.

4건은 Eli Lilly 2건, GE Healthcare 1건, Infineon 1건이며 모두 타겟 기술과 무관하다는 제외 판정이다. 이 표본으로 승인 시그널 문안의 품질이나 월 전체 PDF 생성을 검증했다고 주장하지 않는다. 이번 Gemini 경로에서는 아직 월 전체 PDF를 생성하지 않았다. 기존 발행 파일은 유지됐다. 로컬 테스트는 34건 통과했으며, 실제 응답에서 확인된 사업동향의 비적용 필드는 코드가 고정하도록 수정했다.
