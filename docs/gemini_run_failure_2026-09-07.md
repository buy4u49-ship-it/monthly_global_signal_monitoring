# Gemini 경로 전체 실행 실패 조사 (2026-09-07)

`feat/local-monthly-report`에서 `gemini-3.5-flash-lite`로 8월분 전체(294 기사)를 돌리다가
31번째 기사에서 런 전체가 중단됐다. 아래 1~6절은 최초 인계 당시 조사이며, 후속 확인·수정은 7절에 기록한다.

## 1. 사실관계

| 항목 | 값 |
|---|---|
| 실패 run | GitHub Actions `collect-company-signals` [34070769175](https://github.com/KOTRA-InvestKOREA-HT/monthly_global_signal_monitoring/actions/runs/34070769175) |
| 커밋 | `df216bd` (이후 `3372baf`, `1fd6499`에서 delay 범위만 조정, 동작 변화 없음) |
| 모델 | `gemini-3.5-flash-lite` (무료 티어에서 정상 응답 확인됨. 어제 3.8/3.7-flash는 503, 2.5-flash는 404였다) |
| 관측 RPM | AI Studio 대시보드에서 이 프로젝트/모델 **15 RPM** |
| Variables | `GEMINI_MAX_REQUESTS`·`GEMINI_DELAY_MS` 미설정 → 기본 40건 / 15초 |
| 8번 스텝 소요 | 476초 = 요청 1건 + 30×15초 대기 + API ≈ 31 요청 |
| 결과 | 8번 스텝 실패. 캐시 저장·artifact 업로드는 `always()`로 정상. 검증·PDF·커밋 스텝 스킵 |

`gemini-report-34070769175-1` artifact의 `status.json`:

```json
{ "status": "failed", "reason": "validation_or_execution", "http_status": null, "model": "gemini-3.5-flash-lite" }
```

`http_status: null`만으로 HTTP 200이나 검증 실패를 확정할 수는 없다(네트워크·파일 오류도 가능).
후속 실제 로그 확인으로 이번 실패는 `importReview`의 인용 검증 오류임을 확정했다(7절).

앞 30개 기사는 정상 판정·저장됐다(`reviews/`에 정책 해시 `6e448b36…` 매칭 30건).
성공 판정 중 6건은 비어있지 않은 `evidence_quotes`로 exact-match 검사를 통과했다 —
즉 flash-lite가 원문 인용을 정확히 뽑는 것 자체는 가능하다.

## 2. 실패 기사

스냅샷 `2026-08-17aeecaabf0b47dd885993d7/snapshot.json`, articles[30]:

- **Mitsubishi Chemical**, `https://www.mcgc.com/english/news_release/02749.html`
- "Contract Signed with JOGMEC for Design Work Related to Ship-Based Advanced CCS Project
  -Aiming to establish one of Japan's largest CCS hubs at the Mizushima Industrial Complex-"
- 후보 6개(투자지표 1~5 + 사업동향), 근거 3블록 4,915자
- 내용상 선행 투자활동(설계·타당성 검토 계약) → 모델이 승인 판정을 냈을 가능성이 높고,
  그러면 `evidence_quotes`가 필요하다.

## 3. 원인: 스크레이핑 근거의 유니코드·엔티티 불일치 + 취약한 인용 검사

`local_report.mjs`의 인용 검사(133행)는 `clean()`으로 **공백만** 정규화한 뒤
`evidenceText.includes(quote)`로 부분문자열 일치를 본다. 승인인데 인용이 비어 있으면 136행에서
throw. 이 기사 근거 텍스트에는 다음이 섞여 있다:

- **디코딩 불일치**: `Japan's largest CCS hubs`는 굽은 따옴표(`'`, U+2019)로 디코딩됐는데,
  같은 문서의 `Mizushima&rsquo;s industrial strengths`, `complex&rsquo;s layout`,
  `&nbsp;`는 **HTML 엔티티 문자열 그대로** 남아 있다.
- **아래첨자**: `CO₂`(U+2082), `CO2`, `CO 2`가 혼용.
- **네비게이션 잔재**: "HOME News Releases …", 반복된 제목, `*1` `*2` `・` 각주 기호.

모델이 자연스러운 문장을 인용하면(직선 따옴표 `'`, `CO2`) 근거의 굽은 따옴표·엔티티·첨자와
글자 단위로 어긋나 `includes()`가 실패한다. `clean()`은 이를 흡수하지 못한다.

정확한 throw 메시지는 8번 스텝 로그에 있다(인증 필요로 미확인). 후보 ID와 사유
("evidence_quotes must be exact passages" vs "approved candidate needs an evidence quote")가
찍혀 있으므로, 로그를 확보하면 3-1/3-2 중 무엇인지 확정된다.

## 4. 구조적 문제

`scripts/gemini_report.mjs`의 `reviewArticles`(101행 부근):

```js
if (error.status === 429 || error.status >= 500) return { status: 'paused', ... };
throw error;   // ← 그 외 모든 오류가 런 전체를 죽인다
```

무료 소형 모델이 294건을 처리하면 개별 응답 하자(인용 불일치, 후보 누락, JSON 절단,
`finishReason=MAX_TOKENS`)는 사실상 매 실행 발생한다. 한 건이 30분 실행분과 그때까지의
API 호출을 함께 날린다(완료분 캐시는 남지만 런은 실패로 종료, 이후 PDF·커밋 스텝 스킵).

## 5. 제안 (미구현, 논의 필요)

1. **인용 매칭 정규화 강화** — 양쪽에 적용: HTML 엔티티 디코딩(`&rsquo;` `&nbsp;` `&amp;` …),
   유니코드 구두점 폴딩(굽은 따옴표→직선, 대시류→`-`, `₂`→`2`, NBSP→space), 그다음 `includes`.
   3절이 실제 원인이면 이것만으로 대부분 해소된다. `clean()`을 이 정규화로 교체하고
   `local_report.mjs`와 `gemini_report.mjs` 양쪽 계약 테스트를 갱신한다.
2. **개별 기사 실패에 회복력** — 검증/파싱 오류 시:
   - 더 엄격한 인용 지침으로 **1회 재요청**("문장을 글자 그대로 복사할 수 없으면
     quality=needs_review"), 실패 시
   - 그 기사만 `needs_review`(수집·검토 보류)로 기록하고 **계속 진행**.
   - 런 종료 시 스킵된 기사 목록을 `status.json`과 스텝 요약에 남긴다.
3. **build 처리** — 스킵분은 PDF 매트릭스에서 "검토 자료에서 미포착"이 아니라 "확인 보류"로
   분류(`coverage.json`에 이미 있는 구분). 스킵이 0건일 때만 무조건 발행.
4. (별건) 근거 텍스트 품질 — "HOME News Releases" 등 네비게이션 잔재가 근거로 들어온다.
   수집·본문 추출 단계의 정제는 이 이슈와 분리된 후속 작업.

3절 원인 확정 전에는 1번을 우선 검증(로컬에서 이 기사 근거 + 모델이 낼 법한 인용으로 재현).
1번으로 안 되는 잔여 케이스가 2번의 대상이다.

## 6. 이 세션에서 브랜치에 올린 커밋

| 커밋 | 내용 |
|---|---|
| `4268999` | `GEMINI_MODEL` 오버라이드 추가 (다음 커밋에서 되돌림) |
| `08f67a4` | 모델을 `gemini-3.5-flash-lite`로 하드코딩 |
| `df216bd` | 워크플로 JS 액션을 Node 24 버전으로 (cache@v5, upload-artifact@v6) |
| `3372baf` | delay 하한 5s, 요청 상한 400 |
| `1fd6499` | delay 하한 4s (관측 15 RPM 반영), 안전값 4500ms |

모델 상수·정책 문구가 바뀌면 `policy` 다이제스트가 바뀌어 이전 판정 캐시는 재사용되지
않는다(스냅샷 5개가 서로 다른 policy 해시인 이유). 1·2번을 구현하면 `VERSION` 또는 프롬프트가
바뀌므로 캐시 전량 무효화를 감안한다.

## 7. 후속 확인 및 수정 (2026-09-07)

GitHub 연결 도구로 위 run의 job `101587572276` 로그를 직접 확인했다.
`2026-09-07T00:52:50.3970904Z` 오류는 다음과 같다.

```text
Mitsubishi Chemical relevant: evidence_quotes must be exact passages from this article
```

실패한 모델 응답 원문은 저장되지 않아 실제로 어떤 인용 문자가 달랐는지는 확정하지 못했다.
유니코드/엔티티 불일치는 재현 가능한 원인 후보이며, 모델의 의역 가능성도 남아 있다.

수정 사항:

- 인용 비교에만 HTML 숫자 엔티티·주요 구두점 엔티티, 굽은 따옴표, 대시, 아래첨자 숫자 및 공백 정규화를 적용했다. 원문·기사 ID는 유지한다. 의역, 숫자 변경, 서로 다른 근거 블록을 이어 붙인 인용은 여전히 거부한다.
- 잘못된 JSON·불완전 응답·후보/인용 검증 실패는 원문 복사 지침을 추가해 1회 재요청한다. 재시도에도 동일한 요청 상한과 대기 시간이 적용된다.
- 두 번 실패한 기사는 유효 판정 캐시에 넣지 않고 다음 기사로 진행한다. 실패 기사 ID와 안전한 오류 코드를 `status.json` 및 Actions 요약에 남긴다. 미검증 기사가 남으면 `paused/invalid_responses`로 발행을 막고, 다음 실행은 캐시된 정상 기사를 건너뛴다.
- HTTP 429/5xx와 전송 오류는 진행 상태를 저장하고 중단한다. 인증·설정·파일 기록 오류는 실패로 유지한다.
- 실패를 자동으로 `needs_review` 판정으로 바꿔 발행하지 않는다. 모델이 직접 반환한 유효한 `needs_review`는 기존 coverage 규칙대로 처리한다.
- 모델, 기본 프롬프트, 판정 정책 해시 및 버전을 유지했다. 추가 지침은 실패 후 재시도에만 사용하므로 기존 완료분 캐시를 전량 무효화하지 않는다. 캐시는 읽을 때마다 현재 검증을 다시 통과해야 한다.

검증: `npm test`로 인용 정규화, 위조 인용 거부, 재시도, 요청 상한, 할당량/인증 오류, 후속 기사 저장 및 재개를 확인했다. 실제 Gemini API로 월 전체를 재실행한 결과는 아직 아니다.

참고: [Google 구조화 출력 문서](https://ai.google.dev/gemini-api/docs/structured-output)는 출력 값의 의미적 정확성은 별도로 검증해야 한다고 명시한다.

## 8. 다음 실행의 별도 오류: 503 capacity

다운로드된 `gemini-report-34073101402-1/status.json`은 `paused`,
`reason=provider_unavailable`, `http_status=503`, `provider_reason=capacity`다.
30건을 캐시에서 복원한 뒤 첫 새 요청이 서버 용량 부족으로 거절됐다.
앞선 인용 불일치나 429 할당량 초과와는 별개다. 기존 요약의 `after quota reset`은
모든 일시정지에 공통으로 출력되던 문구여서 이번 원인을 설명하지 못했다.

5xx/전송 오류에 기사당 최대 두 번 자동 재시도를 추가했다. 대기는 약 15초, 30초에
최대 1초 미만의 무작위 지연을 더하고 설정된 요청 간격보다 짧아지지 않는다.
모든 시도는 실행당 요청 상한에 포함된다. 계속 실패하면 기존 캐시를 보존하고 일시정지한다.
429는 기존처럼 즉시 일시정지하며 인증 오류는 재시도하지 않는다.
이는 [Google의 제한된 지수 백오프 권고](https://ai.google.dev/gemini-api/docs/troubleshooting)에 따른 처리다.

## 9. HyproMag 반복 인용 오류 확정 및 처리

`gemini-report-34076548123-1`의 두 진단 파일에서 기사
`36d9a61515eb0be863c981c9`의 실제 인용을 비교했다. 첫 응답에는 `...`로 생략한
인용도 있었다. 재시도에서는 그것들이 수정됐지만 `investment:2`가 여전히 실패했다.

원문에는 Remloy 독일 공장 설명, HyProMag와의 공정 상호보완성 설명, 연간 500톤
목표 생산능력 설명이 차례로 있다. 모델은 첫 문장과 세 번째 문장을 하나의 인용으로
이어 붙였다. 각각은 원문 그대로지만 두 문장이 연속으로 존재하지 않아 검증이 실패했다.
이번 오류의 원인은 유니코드 표기 차이가 아니라 중간 문장을 생략한 인용 결합이다.

Gemini 응답 처리에 보수적인 인용 분리를 추가했다. 일치하지 않는 복수 문장 인용은
모든 문장이 같은 원문 블록 안에 같은 순서로 정확히 존재할 때만 별도 인용 항목으로
분리한다. 생략부호, 바뀐 숫자·단어, 역순 문장, 서로 다른 블록의 결합은 허용하지 않는다.
분리 전 인용과 분리 결과·근거 블록 번호는 판정 파일의 `quote_repairs`에 남긴다.
후보 판정, 요약, 원문, 정책 해시 및 기존 캐시는 변경하지 않는다.

실제 실패 인용을 회귀 테스트에 추가했다. API를 새로 호출한 검증은 아니며,
모델의 의미 판정이 옳다는 보증도 아니다. 수정본으로 남은 기사 응답을 다시 받아
전체 검증과 PDF 생성까지 통과해야 월 보고서 완료로 볼 수 있다.
