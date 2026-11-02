# 저널 TUI

오늘의 Logseq Markdown 저널을 전체 화면으로 표시하고 선택 항목의 TODO/DONE 상태를 변경합니다. Node.js 18 이상에서 외부 패키지 설치 없이 실행합니다.

```sh
/Users/hyunho/Work/logseq-og/scripts/journal
/Users/hyunho/Work/logseq-og/scripts/journal --print
/Users/hyunho/Work/logseq-og/scripts/journal --date 2026-11-02
/Users/hyunho/Work/logseq-og/scripts/journal --graph ~/documents/bilog2
/Users/hyunho/Work/logseq-og/scripts/journal ~/documents/bilog2/journals/2026_11_02.md
/Users/hyunho/Work/logseq-og/scripts/journal --print --color always | less -R
```

어디서든 `journal`로 실행하려면 셸 설정에 다음 별칭을 추가합니다.

```sh
alias journal='/Users/hyunho/Work/logseq-og/scripts/journal'
```

## 표시와 갱신

- 기본 그래프는 `~/documents/bilog2`입니다. `--graph`, `LOGSEQ_GRAPH`, 기본값 순으로 결정합니다.
- `journals/YYYY_MM_DD.md`를 읽고 원래 계층을 표시합니다. 탭은 공백 두 칸으로 표시합니다.
- TODO와 `[ ]`는 노란색 `☐ TODO`, DONE과 `[x]`는 초록색 `☑ DONE`으로 표시합니다.
- 한글·이모지 너비를 고려해 긴 문장을 줄바꿈합니다. 실제 셀 너비는 터미널 글꼴에 따라 다를 수 있습니다.
- 0.5초마다 다시 읽어 외부 수정과 파일 교체 저장을 감지합니다. 내용이 바뀔 때 화면을 갱신하고 알림을 표시합니다.
- 동일 항목은 본문·상위 항목·동일 본문 출현 순서로 대응하여 선택, 접기 상태, 화면 상단 위치를 최대한 유지합니다. TODO/DONE 변경은 동일 항목으로 취급합니다. 본문 변경·삭제 또는 동일 본문 항목의 재배열 시 위치가 달라질 수 있습니다.
- 오늘 파일이 없으면 생성될 때까지 기다립니다. 열려 있던 파일을 읽을 수 없으면 마지막 내용을 유지하고 오류를 표시하며 재시도합니다.
- 로컬 시간 기준 자정에 새 날짜로 전환합니다. `--date`나 개별 파일 경로를 지정했다면 해당 날짜·파일을 유지합니다.
- `t`를 누르면 선택한 항목의 상태를 원본 파일에 저장합니다. 종료 시 기존 터미널 화면과 입력 모드를 복원합니다.

## TUI 전용 단축키

Logseq 단축키 대신 수정 키 없이 사용할 수 있는 전용 단축키를 사용합니다.

| 동작 | 단축키 |
|---|---|
| 위·아래 항목 이동 | ↑ / ↓ 또는 k / j |
| 하위 항목 접기 / 펼치기 | ← / → |
| 접기·펼치기 전환 | Space |
| TODO/DONE 변경·저장 | t |
| 선택 블록과 하위 항목만 보기 | Enter |
| 전체 보기 복귀 / 도움말 닫기 | Esc |
| 페이지 스크롤 | PgUp / PgDn |
| 처음 / 끝 | Home / End |
| 도움말 | ? |
| 종료 | q / Ctrl+C |

긴 항목 내부를 읽을 때는 페이지 스크롤을 사용합니다. Cmd·Option 및 이전 Ctrl+P/N 매핑은 사용하지 않습니다. 본문 직접 편집은 지원하지 않으며 `t`로 작업 상태만 변경합니다.

iTerm2 일반 탭에서 `journal`을 실행하면 됩니다. 앞서 만든 Journal 전용 프로필은 실행용으로 유지하며 추가했던 키 매핑은 제거했습니다.

## 상태 변경과 블록 보기

- `t`: TODO → DONE → TODO로 전환해 즉시 저장합니다. 상태 없는 항목은 TODO로 만듭니다.
- Markdown 체크박스는 `[ ]` ↔ `[x]`로 전환하여 표기를 유지합니다. NOW·DOING 등 다른 작업 상태와 코드 블록은 변경하지 않습니다.
- 선택 항목 첫 줄의 상태만 바꾸고, 하위 항목·속성·들여쓰기·CRLF·마지막 줄바꿈은 유지합니다.
- 저장 전 현재 파일과 화면의 원문이 같은지 검사합니다. 외부 변경이 있으면 저장하지 않고 갱신하므로 내용을 확인한 후 `t`를 다시 누르세요.
- 같은 디렉터리의 임시 파일에 기록한 뒤 원본을 교체합니다. 교체 직전에도 변경 여부를 재확인하지만, 다른 편집기와 공유 잠금을 사용하지 않으므로 정확히 동시에 저장하는 상황까지 완전히 배제하지는 못합니다.
- `Enter`: 선택한 블록과 그 하위 항목만 표시하며 선택 블록은 펼칩니다. 이 화면에서도 접기·이동·상태 변경·자동 갱신이 가능합니다.
- `Esc`: 전체 보기로 돌아가 진입했던 항목을 다시 선택합니다. 도움말이 열려 있으면 도움말부터 닫습니다.
- 블록 보기 중 해당 블록이 외부에서 삭제되거나 식별할 수 없게 바뀌면 전체 보기로 복귀합니다.

## 기존 출력 모드

`--print`는 출력 후 종료합니다. 파이프·파일 출력에서는 색상을 생략하고 상태 기호와 글자는 유지합니다. `--color never` 또는 `NO_COLOR` 환경변수로 자동 색상을 끌 수 있습니다. `--color always`는 색상 출력을 강제합니다. 파일이 없으면 오류와 종료 코드 1을 반환합니다. TUI는 입력·출력이 모두 터미널이어야 합니다.

## 검증

```sh
node --test scripts/journal.test.cjs
python3 scripts/journal-pty-test.py
```

PTY 통합 검증은 Unix 환경에서 임시 그래프와 모의 시간을 사용해 파일 생성 대기, 접기·펼치기, 분할 키 입력, 파일 교체 저장, 상태 저장과 충돌 거부, 블록 보기·복귀, 도움말, 자정 전환, 터미널 복원을 확인합니다.
