# Gemini 무료 API 보고서 실행

기존 `collect-company-signals.yml` 실행을 Gemini 기사별 분석으로 변경했다. `OPENAI_API_KEY`를 사용하거나 유료 모델로 전환하지 않는다. 키워드 필터 탈락분을 포함한 기간 내 모든 기사를 검토하며, 기사당 한 번의 요청으로 투자지표 5개와 사업동향을 판단한다. 검증된 한·영 문안은 기존 PDF 생성기로 출력한다.

## 최초 설정

- GitHub Actions Secret: `GEMINI_API_KEY` (등록 확인 완료).
- Google AI Studio에서 키가 속한 프로젝트가 **결제를 연결하지 않은 Free Tier**인지 확인한다. 그 다음 GitHub Actions **Variable** `GEMINI_FREE_TIER_CONFIRMED`를 `true`로 설정한다. 이 값이 없으면 크롤링·API 호출 전에 종료한다.
- 모델은 `gemini-3.5-flash-lite`로 고정했다. 2026-09-07 Google 공식 가격표에서 Free Tier "Free of charge" 대상이다. 생성 요청의 실제 응답·용량은 실행으로 확인한다(2026-09-07 기준 `gemini-3.8-flash`·`gemini-3.7-flash`는 503, `gemini-2.5-flash`는 404였고, `gemini-3.1-flash-lite`는 응답을 검증했다). 503/404로 멈추면 `gemini-3.1-flash-lite`로 되돌린다.
- 무료 모델이라도 유료 프로젝트 키로 호출하면 과금될 수 있다. 코드나 API 키 이름, 모델 이름으로 결제 상태를 판별할 수 없다. 결제를 연결할 경우 확인 변수를 해제하고 재검토해야 한다.
- 무료 서비스에는 입력의 제품 개선 사용 조건이 있다. 공개 기사와 분석에 필요한 기업·기술·지표 기준을 전송한다. 비공개 내부 전략 자료는 입력하지 않는다.

공식 근거: [가격표](https://ai.google.dev/gemini-api/docs/pricing), [할당량](https://ai.google.dev/gemini-api/docs/rate-limits), [구조화 응답](https://ai.google.dev/gemini-api/docs/structured-output).

## 실행과 이어가기

1. GitHub Actions에서 `collect-company-signals`를 실행한다. 이번 변경을 시험할 때는 `feat/local-monthly-report` 브랜치를 선택한다. 날짜를 비우면 직전 달을 사용한다.
2. 기본적으로 저장된 같은 기간 원문을 재사용한다. 처음에는 크롤링한다. `refresh=true`는 원문을 새로 수집한다. 이어가기에는 `false`를 유지한다.
3. 한 번 실행할 때 API 요청은 재시도를 포함해 기본 최대 400건, 요청 사이 대기는 4.5초다. 실행 화면의 `gemini_max_requests`(1~400), `gemini_delay_ms`(4000~60000)로 조절한다. 우선순위는 실행 입력 → Actions Variables `GEMINI_MAX_REQUESTS`/`GEMINI_DELAY_MS` → 코드 기본값이다. 실행 입력 기본값이 있으므로 기존 저장소 변수 40건/15초보다 우선한다. 실제 할당량을 보장하는 수치는 아니다. AI Studio에서 이 프로젝트·모델의 RPM을 확인하고 `60000 / RPM` 이상으로 대기를 잡는다. 2026-09-07에는 15 RPM으로 관측됐다. 294건의 순수 대기는 약 22분이며 API 응답·재시도·PDF 생성 시간은 별도다. 429가 나면 저장 후 멈추고 다음 실행이 이어간다. 새 모델은 실행 입력 요청 상한을 2~3으로 낮춰 먼저 확인한다. 모델이 바뀌면 캐시 식별자가 바뀌어 앞선 판정은 재사용되지 않는다.
4. 429(한도 초과), 서버 오류, 실행당 요청 상한에서는 저장 후 멈춘다. GitHub 실행은 실패로 표시되며 실행 요약과 artifact의 `status.json`에 `paused`와 진행 건수가 남는다. **할당량 회복 후 같은 날짜로 다시 실행**하면 남은 기사부터 진행한다. 자동 예약 재실행은 아직 연결하지 않았다.
5. 모든 기사의 응답이 검증된 후 한·영 PDF와 대시보드 JSON을 함께 커밋한다. 성공한 실행의 `monthly-report-pdfs-*` artifact에서도 PDF를 다운로드할 수 있다. 대기·오류 중에는 기존 발행물을 교체하지 않는다.

원문과 판정 캐시는 GitHub Actions Cache에 보관한다. 캐시는 영구 저장소가 아니므로 삭제·퇴거되면 재수집/재분석이 필요하다. 실행마다 `gemini-report-*` artifact에도 30일 보관한다. 이 artifact의 복원은 자동화하지 않았다. 새 실행이 기존 실행을 취소하지 않도록 같은 브랜치에서는 순서대로 처리한다. 진행 중 사용자가 강제 취소하면 마지막 캐시 저장 이후 결과는 유실될 수 있다.

## 판정과 검증 범위

### 반복되는 인용 오류 진단

Gemini가 떨어진 복수 문장을 한 인용으로 결합한 경우, 각 문장이 같은 원문 블록에
같은 순서로 정확히 존재하는지 확인해 별도 인용으로 분리한다. 변경 내역은 판정 파일의
`quote_repairs`에 남긴다. 생략부호나 바뀐 숫자·단어를 자동 수정하지 않는다.

`evidence_mismatch`가 반복되면 같은 실행을 계속 돌리기보다 `gemini-report-*` artifact의
`status.json`에 있는 `diagnostics[].file`을 확인한다. 파일은
`reviews/diagnostics/<article_id>/<고유 ID>-attempt-1.json` 형식이며 Actions 요약에도 경로가 표시된다.
각 응답 시도별로 기록하고 이후 실행에서도 이전 파일을 덮어쓰지 않는다.

진단 파일의 `decisions`에는 후보 ID, 모델이 반환한 인용문(`quote`), 비교에 사용한
정규화 문장(`normalized`), 일치한 원문 블록 번호(`matching_block_indices`)가 있다.
빈 번호 배열이면 해당 인용문이 어느 블록에도 일치하지 않았다는 뜻이다.
`evidence_blocks`에는 원문과 정규화한 원문을 함께 보관한다. 빈 인용 배열과 잘못된 자료형도 구분한다.
JSON 파싱 등 인용 비교 이전 단계의 오류에는 원문 응답 대신 오류 코드와 시도 정보만 남긴다.

응답 전체·생각·요약·요청 헤더는 진단 파일에 저장하지 않으며, 설정된 API 키가 문자열에
포함되면 마스킹한다. 진단 파일은 판정 캐시로 사용하지 않는다. 기존 293건 등 정상 캐시는
그대로 재사용하고 실패 기사만 다시 요청한다. 이 변경은 원인 확인용이며 인용 검증을 완화하지 않는다.

- 원문·기업 기술·판정 정책·모델이 바뀌면 캐시 식별자가 바뀐다.
- 후보 누락, 잘못된 인용, 불완전 JSON, 출력 토큰 초과는 기사당 1회 재요청한다(요청 상한·대기 시간 포함). 다시 실패하면 해당 기사는 미완료로 남기고 다음 기사를 분석한다. 미완료가 남으면 `paused/invalid_responses`로 보고서 발행을 차단한다. 이미 완료한 기사의 캐시는 저장하므로 같은 기간으로 다시 실행하면 실패·미처리 기사만 요청한다. 인증 오류는 즉시 실패한다.
- 인용 비교는 주요 HTML 엔티티·따옴표·대시·아래첨자 숫자·공백 표기 차이를 허용하며, 의역이나 숫자 변경은 허용하지 않는다. 실패 기사 ID와 오류 코드는 `status.json`과 Actions 요약에서 확인한다.
- `needs_review`는 시그널 없음으로 단정하지 않으며 수집·검토 부족으로 보고한다. 정확한 인용 일치는 의미 판단의 정확성을 보장하지 않는다.
- `npm test`는 기존 계약과 Gemini 요청·재개·차단 동작을 검증한다. 모의 응답 테스트이며 실제 Gemini 판정 품질을 검증한 것은 아니다.
- Vercel은 설정된 `GITHUB_REF`의 워크플로를 실행한다. 기본값 `main`에서는 브랜치 변경이 아직 반영되지 않는다. 이 변경만으로 기존 Vercel PDF의 배포 시점 데이터 문제가 해결되는 것은 아니다. 이번 범위는 Actions의 Gemini 분석·PDF 생성이며 배포와 다운로드 경로 개선은 별도다.

로컬 실행에는 `GEMINI_API_KEY`, `GEMINI_FREE_TIER_CONFIRMED=true`, `REPORT_FROM_DATE`, `REPORT_TO_DATE` 및 Python ReportLab 환경이 필요하다. 직원 PC에서 실행할 필요는 없다. `npm run report:gemini`는 개발자용 진입점이다. 기존 `report:local` 경로도 유지한다.

## 실제 연결 검증 (2026-09-07)

교체된 키가 별도 결제 미연결 Free Tier 프로젝트의 키임을 사용자에게 확인한 뒤 `GEMINI_FREE_TIER_CONFIRMED=true`를 등록했다. `gemini-3.8-flash`와 `gemini-3.7-flash`는 반복된 503 capacity 응답, `gemini-2.5-flash`는 모델 목록에는 있었지만 생성 요청에서 404를 반환했다. 이 검증 시점의 최종 모델은 실제 응답을 검증한 `gemini-3.1-flash-lite`였다.

이후 모델을 `gemini-3.5-flash-lite`로 변경했다(2026-09-07 가격표 Free Tier "Free of charge"). 이 모델의 생성 요청 용량은 아직 실행으로 검증하지 않았다. 첫 실행에서 503/404로 멈추면 `gemini-3.1-flash-lite`로 되돌린다.

[검증 실행](https://github.com/KOTRA-InvestKOREA-HT/monthly_global_signal_monitoring/actions/runs/34057393153)에서 기간 내 294개 기사 중 최초 2건을 검증·저장했고, 재실행은 기존 2건을 재사용한 뒤 다음 2건을 저장했다 (`requests=2`, `cached=2`, `completed=4`). 각 기사는 6개 후보 판정을 포함한다. 2건 제한에 따른 종료 코드 75는 의도된 일시정지이며 실제 검증 오류와 구분해야 한다. 검증 종료 후 저장소의 요청 상한 변수를 운영 기본값 40으로 복구했다.

4건은 Eli Lilly 2건, GE Healthcare 1건, Infineon 1건이며 모두 타겟 기술과 무관하다는 제외 판정이다. 이 표본으로 승인 시그널 문안의 품질이나 월 전체 PDF 생성을 검증했다고 주장하지 않는다. 이번 Gemini 경로에서는 아직 월 전체 PDF를 생성하지 않았다. 기존 발행 파일은 유지됐다. 로컬 테스트는 34건 통과했으며, 실제 응답에서 확인된 사업동향의 비적용 필드는 코드가 고정하도록 수정했다.
