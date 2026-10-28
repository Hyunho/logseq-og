# 개인용 Logseq OG 개발 환경

- 준비일: 2026-10-26
- 경로: `/Users/hyunho/Work/logseq-og`
- 원본: https://github.com/logseq/og (`version/file`)
- 기준 커밋: `6e7afa8eb`
- 작업 브랜치: `codex/personal-og`
- 기존 bilog: `/Users/hyunho/Work/logseq` (수정하지 않음)

## 실행

### 개발 서버 없는 macOS 앱

- 앱: `/Users/hyunho/Work/logseq-og/build/macos/Logseq-OG-darwin-arm64/Logseq-OG.app`
- Finder에서 앱을 더블클릭해 실행한다. 앱 번들을 응용 프로그램 폴더로 옮겨도 된다.
- Electron과 실행 자산이 포함되어 Node, Java, Clojure 또는 개발 서버가 필요 없다.
- 이 Mac의 Apple Silicon용 로컬 빌드이며 ad-hoc 서명했다. Apple 공증 배포본은 아니다.
- 2026-10-27 검증: 개발 서버 포트 3001/9630 종료, 외부 NODE_ENV 미설정 상태에서 패키지 실행, `app.isPackaged=true`, `NODE_ENV=production`, 로컬 `electron.html` 시작 화면 표시, renderer 오류 0건 확인.

재빌드할 때는 개발 앱과 watch 서버를 먼저 종료한 후 실행한다:

```sh
cd /Users/hyunho/Work/logseq-og
source .local-tools/env.sh
yarn gulp:build
clojure -M:cljs release app --config-merge '{:output-dir ".local-tools/standalone-release/js" :release {:asset-path "./js"}}'
clojure -M:cljs release electron --config-merge '{:output-to ".local-tools/standalone-release/electron.js"}'
LOGSEQ_RELEASE_DIR="$PWD/.local-tools/standalone-release" node scripts/package-macos.cjs
open build/macos/Logseq-OG-darwin-arm64/Logseq-OG.app
```

`package-macos.cjs`는 로컬 Electron 다운로드 캐시가 있으면 재사용하며, 빌드 결과를 `build/macos`에 생성한다. 재패키징하면 같은 경로의 앱을 교체한다.

### 개발 모드

터미널 1:

```sh
cd /Users/hyunho/Work/logseq-og
.local-tools/start-dev.sh
```

`:app`과 `:electron`의 Build completed 후 터미널 2:

```sh
cd /Users/hyunho/Work/logseq-og
.local-tools/open-dev.sh
```

`.local-tools`는 이 컴퓨터에만 설치하고 Git의 local exclude에 등록했다.
환경은 Node 22.23.4, Java 11.0.32.1, Clojure CLI 1.11.1.1413, Yarn 1.22.22이다.
`.local-tools/env.sh`를 source하면 해당 셸에서만 적용된다.

## 초기 환경 확인 결과 — 2026-10-26

아래는 환경을 처음 준비했을 때의 기록이다. 이후 검증 결과와 구분한다.

- 원본 단위 테스트: 194 tests / 1682 assertions, 0 failures / 0 errors.
- 개발 빌드: app 및 electron 완료.
- Mac 개발 모드에서 electron-deeplink의 번들 변조를 건너뛰도록 core.cljs 수정.
- 수정 후 electron 증분 컴파일 완료. 이 변경은 Electron 시작 경로이며 위 원본 단위 테스트 결과와 구분한다.
- 개발 Electron 번들은 로컬 ad-hoc 서명 및 codesign 검증 완료.
- 앱 실행 로그에서 Starting, shadow-cljs ready, config 디렉터리 감시 확인.
- 초기 준비 당시에는 Mac 잠금으로 화면 확인이 미완료였다. 이후 실제 한글 입력·저장·재시작 검증은 아래 후속 결과에서 확인한다.
- 원본의 yarn dev-electron-app은 Forge가 루트 개발 의존성의 오래된 fsevents까지 재빌드하다 실패하므로 직접 Electron을 실행한다.
- 개발 모드에서만 macOS 딥링크 등록을 생략한다. 배포 모드 분기는 변경하지 않았다.

## 환경 변경

Homebrew로 node@22와 openjdk@11 및 의존성을 설치했다.
공용 simdjson 갱신으로 기존 Node 26 실행이 깨져 node를 26.10.0에서 26.12.1로 업데이트해 복구했다.
기본 Node 26.12.1과 OG용 Node 22.23.4 실행을 각각 확인했다. 셸 시작 설정은 변경하지 않았다.

## 테스트 재실행

```sh
cd /Users/hyunho/Work/logseq-og
source .local-tools/env.sh
yarn test
```

초기 환경 준비에서는 개인 데이터 이관과 GitHub 원격 fork 생성을 수행하지 않았다.

## 후속 검증 및 관련 문서

- 2026-10-27: 실제 물리 키보드의 두벌식 조합·저장·재시작 검증을 완료했다. [IME 판정 요약](validation/s01-ime-acceptance-summary.json)과 [재현 절차](../src/test/s01/README.md)를 참고한다.
- 2026-10-28: 메타데이터 분리 변경을 release 빌드에 반영해 패키징하고 bilog2에서 재실행·편집·저장을 검증했다. [메타데이터 검증 문서](validation/s01-metadata-audit.md)에 기존 LOGBOOK 1건의 명시적 이관과 원문 보존 결과를 기록했다.
- 이 개발 환경 수정의 제품 코드 범위는 macOS 개발 모드의 deeplink 등록 생략이다. 앱 기능·IME 동작을 변경하는 패치는 아니다.
