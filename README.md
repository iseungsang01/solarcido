# Solarcido

`solarcido`는 **SOLAR Commandline Interface Development Operator**입니다. Upstage의 `solar-pro3-260323`만 사용하는 agentic CLI이며, 여러 agent 역할은 분리하지만 실제 호출 모델은 하나만 고정합니다.

## 왜 CLI로 시작하나

CLI는 별도 시각 디자인이 필요 없습니다. 대신 아래 UX가 중요합니다.

- 짧고 읽기 쉬운 진행 로그
- 안전한 기본값
- 작업 디렉터리 범위 제한
- 모델/도구 동작이 예측 가능할 것

## 특징

- 모델 고정: `solar-pro3-260323`
- Upstage OpenAI-compatible API 사용
- planner → executor → reviewer 3단계 workflow
- 로컬 도구 지원
  - `list_files`
  - `read_file`
  - `write_file`
  - `run_command`
  - `finish`

## 실행 방법

1. 의존성을 설치합니다.

```bash
npm install
```

2. Upstage API 키를 설정합니다.

PowerShell 예시:

```powershell
$env:UPSTAGE_API_KEY="your_key"
```

3. CLI를 빌드합니다.

```bash
npm run build
```

4. 전역 명령어처럼 쓰려면 링크합니다.

```bash
npm link
```

`npm link`는 이 로컬 프로젝트를 내 컴퓨터에서 전역 CLI처럼 연결해주는 명령입니다.

5. 이제 `solarcido`를 실행합니다.

```bash
solarcido
```

그러면 interactive shell이 열리고, 자연어로 바로 작업을 지시할 수 있습니다.

```txt
solarcido> 이 저장소 구조 분석해줘
solarcido> README 정리해줘
solarcido> sample.txt 파일 만들고 hello 써줘
```

## 개발 중 빠르게 실행하기

전역 링크 없이 바로 실행하려면:

```bash
npm run dev
```

프로젝트 안에서 로컬 바이너리로만 테스트하려면:

```bash
npm exec -- solarcido --help
npm exec -- solarcido
```

## 명령어 예시

interactive shell 진입:

```bash
solarcido
```

계획만 보기:

```bash
solarcido plan "Create a TypeScript CLI design"
```

직접 실행:

```bash
solarcido run "Inspect this repo and summarize it" --cwd . --max-steps 8 --reasoning medium
```

## interactive shell 예시

```txt
solarcido> 이 저장소 구조 분석해줘
solarcido> README 정리해줘
solarcido> sample.txt 파일 만들고 hello 써줘
```

## 명령어 요약

```bash
solarcido
solarcido plan "your goal"
solarcido run "your goal" --cwd . --max-steps 10 --reasoning medium
```

옵션:

- `--cwd`: 작업 디렉터리 지정
- `--max-steps`: executor 최대 반복 횟수
- `--reasoning`: `low | medium | high`

interactive shell 내부 명령:

- `/help`: 도움말
- `/plan <goal>`: 계획만 생성
- `/run <goal>`: 실행 명시
- `/cwd`: 현재 작업 디렉터리 확인
- `/reasoning`: reasoning 수준 확인
- `/max-steps`: 최대 step 확인
- `/exit`: 종료

## 설계 원칙

- fallback 모델 없음
- alias 대신 버전명 직접 사용
- 시각 UI 없음, 텍스트 UX만 제공
- 도구는 현재 작업 디렉터리 내부로만 제한

## 구조

```txt
src/
  agents/
    executor.ts
    planner.ts
    reviewer.ts
  solar/
    client.ts
    constants.ts
  tools/
    filesystem.ts
    process.ts
    registry.ts
  workflow/
    run-agent-loop.ts
  cli.ts
  index.ts
```

## 다음 확장 후보

- patch 기반 파일 편집 도구
- 승인(required approval) 모드
- 세션 저장/재개
- 테스트/빌드 자동 검증 정책 강화
