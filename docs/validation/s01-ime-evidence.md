# S01 macOS IME 검증 자료

2026-10-27에 수행한 시험 자료를 작업별로 정리했다. 2026-10-28 커밋 정리에서는 JSON/JSONL 형식, 자료 간 판정의 일관성, 스크립트 구문과 스크린샷을 점검했다. 물리 키보드 시험이나 전체 회귀를 새로 실행한 결과는 아니다.

## 판정과 재현

[최종 요약](s01-ime-acceptance-summary.json)은 macOS 두벌식과 당시 개발 빌드의 인수 결과다. [실행 안내](../../src/test/s01/README.md)에 격리 그래프·중복 인스턴스 방지·수동 입력·재시작 절차를 기록했다. 제품 코드에 IME 우회 처리는 추가하지 않았다.

| 작업 | 자료 | 판정 |
| --- | --- | --- |
| 초기 앱 시험 | `s01-native-ime-2026-10-27.json`, 같은 이름의 PNG | 당시 저장 결과 보존; 후속 대조와 함께 해석 |
| 초기 자동화 재검증 | `s01-native-ime-recheck-2026-10-27.json` | 자모 분리 관측. 통과 자료로 계산하지 않음 |
| 순수 Electron 대조 | `s01-ime-origin-{native,protocol}-2026-10-27.json` | OS 입력과 Chromium 프로토콜 입력을 구분. JS dispatch 부재와 양성 대조 확인 |
| CUA run 1 | `s01-ime-acceptance-run-1.json`, `s01-ime-acceptance-trace-1.jsonl` | 조합·정확한 저장·ID 유지 통과 |
| CUA run 2 | `s01-ime-isolated-failure-*` | 조합 없이 자모 입력. 실패 원본 보존 |
| 물리 키보드 run 3 | `s01-ime-physical-control-*` | 정상 조합 관측, 기존 접두어 때문에 고정 본문 검사 실패 |
| 동일 창 대조 | `s01-ime-same-window-control.jsonl` | 입력 경로 비교 자료; 독립적인 전체 통과 결과가 아님 |
| 물리 키보드 run 4 | `s01-ime-acceptance-run-4.json`, `s01-ime-acceptance-trace-4.jsonl`, `s01-ime-acceptance-physical.png` | 최종 정확한 본문 저장·조합 상태 해제·재시작 ID 유지 통과 |

## 자료 범위

- 실제 입력 주체, 실패와 성공, 재시작 여부를 원본 기록대로 보존한다. 자동화 입력을 물리 키보드 입력으로 바꾸어 표기하지 않는다.
- 스크린샷은 격리 그래프의 `한글`·`두 번째` 시험 문서다. 실제 bilog2 본문이나 SQLite를 포함하지 않는다.
- 이벤트 기록에는 재현용 임시 경로·시험 블록 UUID·PID·런타임 버전이 포함된다. 경로와 ID는 당시 증거를 연결하는 값이며 다른 컴퓨터에서 그대로 재사용하는 설정이 아니다.
- `compositionend.isTrusted` 하나만으로 실제 OS 입력 여부를 판정하지 않는다. 관측과 해석의 상세 범위는 [이관 문서의 IME 인수 기록](../bilog-feature-migration.md)에 있다.
