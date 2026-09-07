# Gemini 경로 전체 실행 실패 조사 (2026-09-07)

`feat/local-monthly-report`에서 `gemini-3.5-flash-lite`로 8월분 전체(294 기사)를 돌리다가
31번째 기사에서 런 전체가 중단됐다. 인계용 정리다. **아직 고치지 않았다.**

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

`http_status: null` → HTTP는 200. **429/할당량·용량 문제가 아니다.** 응답 본문이
`importReview`(=`scripts/local_report.mjs`) 검증에서 throw된 것이다.

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
