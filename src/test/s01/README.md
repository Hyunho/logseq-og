# S01 검증

임시 그래프와 별도 Electron userData를 사용한다. 실제 사용자 그래프는 테스트 대상으로 열지 않는다.

```sh
source .local-tools/env.sh
clojure -M:cljs compile app electron
cp resources/js/preload.js static/js/preload.js
clojure -M:test compile test
node static/tests.js
node --test src/test/s01/storage.test.cjs
ELECTRON_RUN_AS_NODE=1 static/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test src/test/s01/storage.test.cjs
node src/test/s01/electron-smoke.cjs
node src/test/s01/electron-recovery.cjs
node src/test/s01/electron-editing.cjs
```

UI 스크립트는 순서대로 실행한다. 저장은 비동기이므로 화면 변경과 실제 파일 저장 완료를 구분한다. 로그의 `PASS`와 종료 코드 0을 확인한다. `GRAPH` 경로에 재현 자료를 남기며 smoke는 상위 폴더에 `result.png`도 저장한다. 예상된 충돌 알림과 renderer 예외는 별도로 확인한다.

- `storage.test.cjs`: 실제 SQLite, 오류 주입, 복구본 작성/파일 교체/캐시 commit 경계의 자식 프로세스 종료, 두 프로세스 동시 저장, 이동/수정안 영속성, 사용자 선택 저널 정리.
- `electron-smoke.cjs`: 기본 편집·ID·외부 변경·충돌·삭제·순환 임베드·문서 생성·제목.
- `electron-recovery.cjs`: CRLF/일반 문단, 실행 중 캐시 삭제/손상, 동명 파일 및 직접·상속 참조 재계산, 재시작 후 충돌 선택, 종료 중 재생성된 SQLite와 화면 캐시의 ID 정합성.
- `electron-editing.cjs`: 구조 편집, 복수 임베드, 저널, 쿼리, 카드 미리보기, PDF 참조 생성 함수의 S01 차단, 두 창 경쟁. PDF 뷰어 전체 기능 테스트는 아니다.

## 실제 한글 IME 수동 검증

```sh
node src/test/s01/electron-native-ime.cjs
```

`IME_READY`가 나오면 **고유 제목과 그래프 경로가 맞는 테스트 Electron 창**을 앞으로 가져와 비어 있는 첫 블록을 직접 클릭한다. 실제 macOS 두벌식 키보드로 **한글 두 글자만** 입력하고 키보드의 **오른쪽 방향키**를 한 번 누른다. `->` 같은 문자를 입력하지 않는다. 기본 4분 안에 입력해야 하며 완료 후 앱은 자동 종료된다. 스크립트는 입력기 설정을 바꾸지 않는다.

- 다른 Electron 인스턴스가 있으면 실행 전에 차단한다. 자동으로 다른 프로세스를 종료하지 않는다. 자동화에서는 재실행마다 앱 바인딩을 갱신하고 제목·그래프 경로를 확인한다. 종료된 앱의 AX 상태를 다시 요청하면 도구가 기본 Electron 창을 재실행할 수 있으므로 완료 후에는 로그와 프로세스 종료로 확인한다.
- 기본 준비는 빈 문자열만 `.fill('')`로 설정한다. 한글 문자열은 자동 입력하지 않는다. `S01_IME_NATIVE_PREP=1`은 블록 열기와 비우기까지 네이티브 조작으로 수행할 때만 사용한다.
- 실제 이벤트·네이티브 키 전달 대상·활성 창·조합 상태 해제·본문 전체 일치·ID 유지·JS 합성 composition 부재를 확인한다. `isTrusted=true`만으로 OS IME가 동작했다고 판단하지 않는다.
- CUA 키 주입은 활성 창에서도 조합 없는 자모 `insertText`로 들어올 수 있다. 물리 키보드와 대조해야 하며 `.fill('한글')`·붙여넣기·합성 이벤트는 대체가 아니다.
- `native-ime-result-N.json/png`, `native-ime-failure-N.json`, `ime-trace-N.jsonl`, `ime-native-window-N.jsonl`을 임시 그래프의 상위 폴더에 보존한다. 성공 결과의 최신 사본은 `native-ime-result.json`이다. 원자적 저장 중 일시적 ENOENT는 저장 완료까지 기다린다.

같은 임시 그래프를 재시작해 검증할 때는 출력된 **그래프 상위 경로**를 사용한다. 이 스크립트가 생성한 표시 파일이 있는 임시 경로만 허용하며 기존 문서를 초기 내용으로 덮어쓰지 않는다.

```sh
S01_IME_ACTOR=physical-keyboard S01_IME_TIMEOUT_MS=600000 \
S01_IME_REOPEN_ROOT=/실제/임시/s01-ui-경로 node src/test/s01/electron-native-ime.cjs
```

`S01_IME_ACTOR`는 실행자가 지정하는 출처 메모이지 물리 장치 인증 기능이 아니다. `S01_IME_DIAGNOSTIC=1`은 같은 창에 순수 textarea를 추가한다. 그 입력칸의 이벤트는 앱 본문 검증을 완료시키지 않는다.

2026-10-27 사용자 물리 키보드에서 조합을 반복 확인하고 최종 정확한 본문 저장·재시작 ID 유지까지 통과했다. S01 인수는 완료했다. 실패와 성공을 구분한 근거는 `docs/bilog-feature-migration.md` 및 `docs/validation/s01-ime-acceptance-summary.json`에 있다.

## 신뢰 플래그 원인 대조

```sh
node src/test/s01/electron-ime-origin.cjs
node src/test/s01/electron-ime-origin.cjs --native
```

첫 명령은 Chromium Input 프로토콜 시험이며 OS IME 검증이 아니다. 두 번째는 `PROBE_READY native` 후 순수 textarea에서 두벌식으로 `한글` 입력 후 오른쪽 화살표를 누른다. 3분 안에 확정하면 결과를 임시 `s01-ime-origin-*/result.json`에 기록하고 종료한다. 자동 입력·Logseq·React·preload·Playwright 없이 OS 입력을 관측한다.

capture/bubble 이벤트와 JS `dispatchEvent` 호출을 기록한다. 실제 조합 중 호출은 0건이어야 하고, 별도 숨김 입력칸에서 실행하는 합성 양성 대조 1건은 계측되어야 한다. 종료 trusted 값은 관측 결과로 저장하며 미래 Chromium에서도 false여야 한다고 강제하지 않는다. 두 모드 모두 2026-10-27 통과했다. 실제 앱 재검증의 자모 분리와는 별개의 결과이며, 최종 앱 인수는 사용자 물리 키보드 결과를 사용한다.

## 접힘 상태·메타데이터 분리

`node src/test/s01/electron-collapsed.cjs`는 별도 임시 그래프에서 접기·펼치기·undo의 MD 바이트/mtime 보존, 재시작 복원, SQLite와 renderer 캐시의 우선순위, 기존 속성 이관, 자동 ID 기록 방어를 검증한다. 먼저 app/electron 개발 빌드를 실행한다. 추가 메타데이터 기록 경로는 `docs/validation/s01-metadata-audit.md`에 정리했다.

## 앱 메타데이터와 사용자 속성

`node src/test/s01/electron-metadata.cjs`는 앱 설정·학습 이력·시간 기록의 별도 저장과 같은 이름의 사용자 속성 보존을 검증한다. 추가 검증은 undo/redo, 반복 작업 일정, 코드 블록 예시, 공개 속성 API, Roam 가져오기, 재시작 및 ID 캐시 삭제 후 복원이다. app/electron 개발 빌드 후 실행하며 다른 UI 스크립트와 순서대로 실행한다.

`logseq/metadata.sqlite`는 기능 이력의 영속 저장소이므로 ID 캐시처럼 삭제하지 않는다. 원문과 함께 보존해야 한다. 기록의 출처를 알 수 없는 기존 MD 속성은 사용자 데이터로 유지한다.
