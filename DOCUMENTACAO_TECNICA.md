# 📚 Documentação Técnica - MicroPython Manager

**Problema:** Desenvolvedores ESP32 precisam de documentação visual completa para entender o fluxo de funcionamento, arquitetura e interações entre componentes do MicroPython Manager.

**Solução:** Documentação abrangente com fluxogramas detalhados, diagramas de arquitetura e ilustrações visuais que facilitem o entendimento do sistema, seguindo as limitações de hardware e software do ESP32.

**Exemplo:** Diagrama completo mostrando desde a descoberta de dispositivos até execução de comandos REPL, incluindo gestão de memória e otimizações específicas para ESP32.

## 🏗️ Arquitetura Geral

```mermaid
graph TB
    %% Camada de Interface
    subgraph "🖥️ Interface VS Code"
        UI[Tree View - Dispositivos]
        CMD[Command Palette]
        REPL[Terminal REPL]
        OUTPUT[Output Channels]
    end

    %% Camada de Gerenciamento
    subgraph "⚙️ Camada de Gerenciamento"
        EXT[Extension.ts<br/>🎯 Coordenador Principal]
        DM[DeviceManager.ts<br/>🔌 Gestão de Conexões]
        RM[REPLManager.ts<br/>💻 Terminal Interativo]
        TP[DeviceTreeProvider.ts<br/>🌳 Árvore Visual]
        FM[FileManager.ts<br/>📁 Gestão de Arquivos]
    end

    %% Camada de Comunicação
    subgraph "📡 Comunicação Serial"
        SP[SerialPort<br/>🔗 Conexão Física]
        PARSER[ReadlineParser<br/>📝 Processamento de Dados]
        QUEUE[Command Queue<br/>⏳ Fila Sequencial]
    end

    %% Hardware ESP32
    subgraph "🔧 Hardware ESP32"
        ESP[ESP32 Device<br/>🧠 320KB RAM<br/>📦 ~3MB Flash]
        MP[MicroPython<br/>🐍 Firmware]
        GPIO[GPIO/Periféricos<br/>📊 I2C/SPI/UART]
    end

    %% Conexões
    UI --> EXT
    CMD --> EXT
    EXT --> DM
    EXT --> RM
    EXT --> TP
    EXT --> FM
    
    DM --> SP
    DM --> PARSER
    DM --> QUEUE
    
    RM --> DM
    REPL --> RM
    
    SP --> ESP
    PARSER --> MP
    QUEUE --> MP
    
    TP --> UI
    OUTPUT --> DM

    %% Estilos
    classDef interface fill:#e1f5fe
    classDef manager fill:#f3e5f5
    classDef comm fill:#fff3e0
    classDef hardware fill:#e8f5e8

    class UI,CMD,REPL,OUTPUT interface
    class EXT,DM,RM,TP,FM manager
    class SP,PARSER,QUEUE comm
    class ESP,MP,GPIO hardware
```

## 🔄 Fluxo Principal de Funcionamento

### 1. 🔍 Descoberta e Conexão de Dispositivos

```mermaid
flowchart TD
    START([🚀 Início]) --> SCAN[🔍 Escanear Portas Seriais]
    
    SCAN --> LIST{📋 Portas Encontradas?}
    LIST -->|Não| EMPTY[⚠️ Nenhuma porta encontrada]
    LIST -->|Sim| FILTER[🔍 Filtrar portas compatíveis<br/>USB/Serial/CH340/CP210x]
    
    FILTER --> SELECT[👆 Usuário seleciona porta]
    SELECT --> CONNECT[🔌 Tentar conexão]
    
    CONNECT --> BAUD[🎛️ Testar BaudRates<br/>115200 → 9600 → 57600]
    
    BAUD --> DETECT{🐍 Detectar MicroPython?}
    DETECT -->|Não| FAIL[❌ Falha na conexão]
    DETECT -->|Sim| VALIDATE[✅ Validar ambiente]
    
    VALIDATE --> VERSION[📦 Obter versão MicroPython]
    VERSION --> SETUP[⚙️ Configurar listeners]
    SETUP --> READY[🎉 Dispositivo pronto]
    
    READY --> TREE[🌳 Atualizar árvore visual]
    
    %% Estilos
    classDef start fill:#4caf50,color:#fff
    classDef process fill:#2196f3,color:#fff
    classDef decision fill:#ff9800,color:#fff
    classDef error fill:#f44336,color:#fff
    classDef success fill:#8bc34a,color:#fff
    
    class START start
    class SCAN,FILTER,SELECT,CONNECT,BAUD,VALIDATE,VERSION,SETUP,TREE process
    class LIST,DETECT decision
    class EMPTY,FAIL error
    class READY success
```

### 2. 💻 Fluxo do REPL Interativo

```mermaid
sequenceDiagram
    participant User as 👤 Usuário
    participant VSCode as 🖥️ VS Code
    participant REPL as 💻 REPLManager
    participant Device as 🔌 DeviceManager
    participant ESP32 as 🧠 ESP32

    User->>VSCode: Comando "Abrir REPL"
    VSCode->>REPL: openREPL(deviceId)
    
    REPL->>Device: Validar conexão
    Device->>ESP32: Testar responsividade
    ESP32-->>Device: Resposta com prompt ">>>"
    
    REPL->>REPL: Validar ambiente MicroPython
    Note over REPL: Testa imports, matemática, sistema
    
    REPL->>VSCode: Criar PseudoTerminal
    VSCode->>User: Mostrar terminal interativo
    
    loop Interação do usuário
        User->>VSCode: Digitar comando Python
        VSCode->>REPL: handleInput(comando)
        REPL->>Device: executeCommand(comando)
        Device->>Device: Adicionar à fila
        Device->>ESP32: Enviar via serial
        ESP32-->>Device: Resposta + prompt
        Device-->>REPL: Saída capturada
        REPL-->>VSCode: Mostrar no terminal
        VSCode-->>User: Exibir resultado
    end
```

### 3. 📁 Gestão de Arquivos

```mermaid
flowchart LR
    subgraph "💻 Local (VS Code)"
        LOCAL[📄 Arquivo .py local]
        EDITOR[✏️ Editor VS Code]
    end
    
    subgraph "🔄 Transferência"
        UPLOAD[⬆️ Upload Process]
        DOWNLOAD[⬇️ Download Process]
        VALIDATE[✅ Validação]
    end
    
    subgraph "🧠 ESP32 (Remoto)"
        FLASH[💾 Flash Storage<br/>~3MB disponível]
        FILES[📁 Sistema de arquivos<br/>boot.py, main.py, ...]
    end
    
    %% Upload Flow
    LOCAL --> UPLOAD
    UPLOAD --> VALIDATE
    VALIDATE --> FLASH
    
    %% Download Flow
    FILES --> DOWNLOAD
    DOWNLOAD --> VALIDATE
    VALIDATE --> LOCAL
    
    %% Edição
    EDITOR <--> LOCAL
    
    %% Detalhes do upload
    UPLOAD -.-> |1. Ler arquivo| LOCAL
    UPLOAD -.-> |2. Escapar conteúdo| UPLOAD
    UPLOAD -.-> |3. Usar modo raw| ESP32
    UPLOAD -.-> |4. JSON.stringify| UPLOAD
    UPLOAD -.-> |5. Verificar criação| FILES
```

## 🔧 Componentes Detalhados

### DeviceManager.ts - 🔌 Gerenciador Central

```mermaid
classDiagram
    class DeviceManager {
        -devices: Map~string, ESP32Device~
        -connections: Map~string, SerialPort~
        -parsers: Map~string, ReadlineParser~
        -outputChannels: Map~string, OutputChannel~
        -commandQueues: Map~string, CommandQueue~
        -isProcessingQueue: Map~string, boolean~
        
        +listSerialPorts() Promise~SerialPortInfo[]~
        +connectDevice(path, baudRate) Promise~ESP32Device~
        +disconnectDevice(deviceId) Promise~void~
        +executeCommand(deviceId, command) Promise~string~
        +uploadFile(deviceId, localPath, remotePath) Promise~void~
        +downloadFile(deviceId, remotePath, localPath) Promise~void~
        +getMemoryInfo(deviceId) Promise~void~
        +resetDevice(deviceId) Promise~void~
        -processCommandQueue(deviceId) Promise~void~
        -detectMicroPython(port, parser) Promise~string~
    }
    
    class ESP32Device {
        +id: string
        +name: string
        +port: string
        +baudRate: number
        +isConnected: boolean
        +micropythonVersion: string
        +lastActivity: Date
    }
    
    class CommandQueue {
        +command: string
        +resolve: Function
        +reject: Function
    }
    
    DeviceManager --> ESP32Device
    DeviceManager --> CommandQueue
```

### REPLManager.ts - 💻 Terminal Interativo

```mermaid
stateDiagram-v2
    [*] --> Disconnected
    
    Disconnected --> Validating: openREPL()
    
    state Validating {
        [*] --> CheckConnection
        CheckConnection --> TestCommands
        TestCommands --> ValidateEnvironment
        ValidateEnvironment --> PrepareDevice
        PrepareDevice --> [*]
    }
    
    Validating --> Connected: Validação OK
    Validating --> Error: Falha na validação
    
    Connected --> Interactive: Terminal criado
    
    state Interactive {
        [*] --> WaitingInput
        WaitingInput --> ProcessingCommand: Comando digitado
        ProcessingCommand --> WaitingResponse: Enviado para ESP32
        WaitingResponse --> WaitingInput: Resposta recebida
    }
    
    Interactive --> Disconnected: Terminal fechado
    Error --> Disconnected: Timeout/Reset
```

### 📊 Fila de Comandos (Command Queue)

```mermaid
graph LR
    subgraph "🎯 Entrada de Comandos"
        USER[👤 Usuário REPL]
        API[🔧 API Calls]
        UPLOAD[📤 Upload Files]
    end
    
    subgraph "⏳ Fila Sequencial"
        Q1[Comando 1<br/>print('hello')]
        Q2[Comando 2<br/>import os]
        Q3[Comando 3<br/>os.listdir()]
        Q4[Comando 4<br/>gc.collect()]
    end
    
    subgraph "🔄 Processamento"
        PROC[🎛️ Processador<br/>Um comando por vez]
        WAIT[⏱️ Aguardar '>>>' prompt]
    end
    
    subgraph "🧠 ESP32"
        EXEC[⚡ Execução]
        RESP[📤 Resposta + '>>>']
    end
    
    USER --> Q1
    API --> Q2
    UPLOAD --> Q3
    
    Q1 --> PROC
    Q2 --> |Aguarda| Q1
    Q3 --> |Aguarda| Q2
    Q4 --> |Aguarda| Q3
    
    PROC --> EXEC
    EXEC --> RESP
    RESP --> WAIT
    WAIT --> |Próximo| PROC
    
    %% Estilos
    classDef input fill:#e3f2fd
    classDef queue fill:#fff3e0
    classDef process fill:#f3e5f5
    classDef esp32 fill:#e8f5e8
    
    class USER,API,UPLOAD input
    class Q1,Q2,Q3,Q4 queue
    class PROC,WAIT process
    class EXEC,RESP esp32
```

## 🔧 Limitações de Hardware ESP32

### 💾 Gestão de Memória

```mermaid
pie title 📊 Distribuição de Memória ESP32
    "RAM Sistema" : 100
    "RAM MicroPython" : 150
    "RAM Usuário" : 70
    "Flash Firmware" : 1024
    "Flash Sistema" : 512
    "Flash Usuário" : 3072
```

### ⚡ Otimizações Implementadas

```mermaid
mindmap
  root((🎯 Otimizações<br/>ESP32))
    🧠 Memória
      Garbage Collection automático
      Chunking para arquivos grandes
      Buffer size limitado
      
    🔌 Comunicação
      Fila sequencial de comandos
      Timeout configurável (10s)
      Retry automático de conexão
      
    📁 Arquivos
      Validação de espaço antes upload
      Compressão JSON para transfer
      Verificação de integridade
      
    ⚡ Performance
      Parser otimizado para ESP32
      BaudRate adaptativo
      Cache de informações do device
```

## 🛠️ Comandos e Funcionalidades

### 📋 Lista Completa de Comandos

| Comando | Função | Arquivo | Otimização ESP32 |
|---------|--------|---------|------------------|
| `scanPorts` | Descobrir dispositivos | extension.ts | Filtra portas USB/Serial |
| `connectDevice` | Conectar ESP32 | deviceManager.ts | BaudRate adaptativo |
| `openREPL` | Terminal interativo | replManager.ts | Validação de ambiente |
| `uploadFile` | Enviar arquivo | deviceManager.ts | Modo raw + JSON escape |
| `downloadFile` | Baixar arquivo | deviceManager.ts | Chunks para arquivos grandes |
| `deleteFile` | Remover arquivo | deviceManager.ts | Verificação de espaço |
| `listFiles` | Listar arquivos | deviceManager.ts | Estrutura otimizada |
| `getMemoryInfo` | Info RAM/Flash | deviceManager.ts | gc.collect() automático |
| `resetDevice` | Soft reset | deviceManager.ts | Ctrl+D via fila |

### 🔄 Fluxo de Upload de Arquivo

```mermaid
sequenceDiagram
    participant User as 👤 Usuário
    participant VS as 🖥️ VS Code
    participant DM as 🔌 DeviceManager
    participant ESP as 🧠 ESP32
    
    User->>VS: Selecionar arquivo .py
    VS->>DM: uploadFile(deviceId, localPath)
    
    DM->>DM: Ler arquivo local
    Note over DM: fs.readFileSync(localPath, 'utf8')
    
    DM->>DM: Escapar conteúdo
    Note over DM: JSON.stringify() duplo escape
    
    DM->>ESP: Entrar modo raw (\x01)
    ESP-->>DM: OK modo raw
    
    DM->>ESP: Comando de escrita
    Note over DM,ESP: ujson.loads() + with open()
    
    ESP->>ESP: Criar arquivo
    ESP-->>DM: Arquivo criado
    
    DM->>ESP: Sair modo raw (\x02)
    ESP-->>DM: Modo normal
    
    DM->>ESP: Verificar arquivo criado
    ESP-->>DM: True/False
    
    DM-->>VS: Status do upload
    VS-->>User: Resultado final
```

## 🐛 Tratamento de Erros

### ⚠️ Cenários de Erro Comuns

```mermaid
graph TD
    START([🔍 Operação Iniciada])
    
    START --> CHECK{🔍 Verificações}
    
    CHECK -->|Porta ocupada| E1[❌ Erro: Porta em uso<br/>💡 Fechar outras aplicações]
    CHECK -->|Driver ausente| E2[❌ Erro: Driver não encontrado<br/>💡 Instalar CH340/CP210x]
    CHECK -->|Permissão negada| E3[❌ Erro: Sem permissão<br/>💡 Linux: sudo usermod -a -G dialout]
    CHECK -->|Timeout| E4[❌ Erro: Timeout 10s<br/>💡 Resetar dispositivo]
    CHECK -->|Memória cheia| E5[❌ Erro: Flash cheio<br/>💡 Limpar arquivos antigos]
    CHECK -->|Comando inválido| E6[❌ Erro: Sintaxe Python<br/>💡 Verificar código]
    
    CHECK -->|Tudo OK| SUCCESS[✅ Operação bem-sucedida]
    
    E1 --> RETRY[🔄 Tentar novamente?]
    E2 --> RETRY
    E3 --> RETRY
    E4 --> RETRY
    E5 --> CLEANUP[🧹 Limpeza automática]
    E6 --> FIX[🔧 Correção manual]
    
    RETRY --> START
    CLEANUP --> START
    FIX --> START
    
    %% Estilos
    classDef error fill:#ffebee,stroke:#f44336
    classDef success fill:#e8f5e8,stroke:#4caf50
    classDef process fill:#e3f2fd,stroke:#2196f3
    
    class E1,E2,E3,E4,E5,E6 error
    class SUCCESS success
    class START,CHECK,RETRY,CLEANUP,FIX process
```

## 📈 Monitoramento e Performance

### 📊 Métricas do Sistema

```mermaid
dashboard
    title 📊 MicroPython Manager - Dashboard
    
    section 🔌 Conexões
        Dispositivos Ativos: 3: [0..10]
        Taxa de Sucesso: 95%: [0..100]
        Tempo Médio Conexão: 2.5s: [0..10]
    
    section 💾 Memória ESP32
        RAM Livre: 180KB: [0..320]
        Flash Usado: 1.2MB: [0..3]
        GC Collections: 45: [0..100]
    
    section ⚡ Performance
        Comandos/min: 12: [0..60]
        Timeout Rate: 2%: [0..10]
        Upload Speed: 8KB/s: [0..20]
    
    section 🐛 Erros
        Conexão: 1: [0..10]
        Upload: 0: [0..10]
        REPL: 1: [0..10]
```

## 🔧 Configurações Avançadas

### ⚙️ Parâmetros de Otimização

```json
{
  "micropython-manager": {
    "serialTimeout": 10000,
    "maxDevices": 10,
    "autoRetryCount": 3,
    "baudRates": [115200, 9600, 57600],
    "chunkSize": 1024,
    "gcThreshold": 0.8,
    "validationTimeout": 15000,
    "replHistorySize": 100
  }
}
```

### 🎛️ Configuração para Diferentes Cenários

```mermaid
flowchart TD
    SCENARIO{🎯 Cenário de Uso}
    
    SCENARIO --> DEV[👨‍💻 Desenvolvimento]
    SCENARIO --> PROD[🏭 Produção] 
    SCENARIO --> DEBUG[🐛 Debug]
    SCENARIO --> LEARN[📚 Aprendizado]
    
    DEV --> |Config| DEV_SET[⚡ Timeout baixo<br/>🔄 Auto-retry alto<br/>📝 Log verboso]
    PROD --> |Config| PROD_SET[⏱️ Timeout alto<br/>🛡️ Validação rigorosa<br/>📊 Métricas]
    DEBUG --> |Config| DEBUG_SET[🔍 Log detalhado<br/>⏸️ Breakpoints<br/>🧠 Memory tracking]
    LEARN --> |Config| LEARN_SET[❓ Tooltips<br/>📖 Documentação<br/>✅ Validação amigável]
    
    %% Estilos
    classDef scenario fill:#e1f5fe
    classDef config fill:#f3e5f5
    
    class SCENARIO scenario
    class DEV,PROD,DEBUG,LEARN scenario
    class DEV_SET,PROD_SET,DEBUG_SET,LEARN_SET config
```

## 🚀 Roadmap de Desenvolvimento

### 📅 Funcionalidades Planejadas

```mermaid
timeline
    title 🗓️ Roadmap MicroPython Manager
    
    section v0.1.0 - Atual
        Descoberta automática    : Implementado
        Conexões múltiplas      : Implementado
        REPL interativo         : Implementado
        Upload/Download         : Implementado
        Gestão de memória       : Implementado
    
    section v0.2.0 - Q1 2025
        Auto-completion         : Em desenvolvimento
        Syntax highlighting     : Planejado
        Error detection         : Planejado
        
    section v0.3.0 - Q2 2025
        Debug com breakpoints   : Planejado
        OTA updates            : Planejado
        ESP8266 support        : Planejado
        
    section v1.0.0 - Q3 2025
        ESP-IDF integration    : Planejado
        Marketplace release    : Planejado
        Full documentation     : Planejado
```

## 📖 Guias de Uso

### 🎯 Para Iniciantes

1. **Conectar ESP32**
   - Conecte via USB
   - Execute "Escanear Portas"
   - Selecione a porta correta

2. **Primeiro código**
   - Abra REPL
   - Digite: `print("Hello ESP32!")`
   - Veja o resultado

3. **Upload de arquivo**
   - Crie arquivo .py
   - Clique com direito no dispositivo
   - Selecione "Upload File"

### 🔧 Para Avançados

1. **Otimização de memória**
   
   ```python
   import gc
   gc.collect()  # Força limpeza
   print(gc.mem_free())  # Verifica RAM livre
   ```

2. **Gestão de arquivos**
   
   ```python
   import os
   os.remove('arquivo_antigo.py')  # Remove
   os.listdir('/')  # Lista todos
   ```

3. **Configuração de hardware**
   
   ```python
   import machine
   machine.freq(240000000)  # CPU 240MHz
   print(machine.unique_id())  # ID único
   ```

---

**Esta documentação é atualizada automaticamente conforme o desenvolvimento do projeto. Para sugestões ou correções, contribua no repositório oficial.**

## 🔗 Links Úteis

- [MicroPython Docs](https://docs.micropython.org/)
- [ESP32 Technical Reference](https://www.espressif.com/sites/default/files/documentation/esp32_technical_reference_manual_en.pdf)
- [VS Code Extension API](https://code.visualstudio.com/api)
- [SerialPort Node.js](https://serialport.io/)

---

📝 **Última atualização:** Dezembro 2024  
👨‍💻 **Versão da documentação:** 1.0.0
