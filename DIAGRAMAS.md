# 🔧 Diagramas Técnicos - MicroPython Manager

## 🏗️ Arquitetura de Classes

```mermaid
classDiagram
    class DeviceManager {
        -devices: Map~string, ESP32Device~
        -connections: Map~string, SerialPort~
        -commandQueues: Map~string, Command[]~
        +listSerialPorts(): Promise~SerialPortInfo[]~
        +connectDevice(portPath: string): Promise~ESP32Device~
        +executeCommand(deviceId: string, command: string): Promise~string~
        +uploadFile(deviceId: string, localPath: string): Promise~void~
        +getMemoryInfo(deviceId: string): Promise~void~
        +resetDevice(deviceId: string): Promise~void~
    }

    class DeviceTreeProvider {
        -fileCache: Map~string, ESP32File[]~
        -onDidChangeTreeData: EventEmitter
        +getTreeItem(element: DeviceTreeItem): TreeItem
        +getChildren(element?: DeviceTreeItem): Thenable~DeviceTreeItem[]~
        +refresh(): void
    }

    class REPLManager {
        -activeREPLs: Map~string, Terminal~
        +openREPL(deviceId: string): Promise~void~
        +validateMicroPythonEnvironment(deviceId: string): Promise~ValidationResult~
        +testBasicCommands(deviceId: string): Promise~boolean~
    }

    class ESP32Device {
        +id: string
        +name: string
        +port: string
        +baudRate: number
        +isConnected: boolean
        +micropythonVersion?: string
        +lastActivity: Date
    }

    DeviceManager "1" --> "*" ESP32Device : manages
    DeviceTreeProvider --> DeviceManager : uses
    REPLManager --> DeviceManager : uses
```

## 🔄 Fluxo de Estados dos Dispositivos

```mermaid
stateDiagram-v2
    [*] --> Scanning
    Scanning --> Found : Device Detected
    Found --> Connecting : User Connect
    Connecting --> Connected : Success
    Connecting --> Error : Timeout/Fail
    Connected --> Validating : Check MicroPython
    Validating --> Ready : Valid
    Validating --> Error : Invalid
    Ready --> Executing : Command Sent
    Executing --> Ready : Command Complete
    Ready --> Disconnected : User Disconnect
    Error --> Connecting : Retry
    Disconnected --> [*]
    
    note right of Ready
        Device ready for:
        - REPL commands
        - File operations
        - Memory monitoring
    end note
```

## 📊 Sequência de Conexão

```mermaid
sequenceDiagram
    participant User
    participant Extension
    participant DeviceManager
    participant SerialPort
    participant ESP32

    User->>Extension: Scan Ports
    Extension->>DeviceManager: listSerialPorts()
    DeviceManager->>SerialPort: SerialPort.list()
    SerialPort-->>DeviceManager: Available ports
    DeviceManager-->>Extension: Port list
    Extension-->>User: Show port selection

    User->>Extension: Connect to port
    Extension->>DeviceManager: connectDevice(portPath)
    DeviceManager->>SerialPort: new SerialPort(config)
    SerialPort->>ESP32: Open connection
    ESP32-->>SerialPort: Connection established
    
    DeviceManager->>ESP32: Send '\r\n'
    DeviceManager->>ESP32: Send 'import sys'
    ESP32-->>DeviceManager: MicroPython response
    DeviceManager-->>Extension: Device connected
    Extension-->>User: Show connected device
```

## 🎯 Fila de Comandos (Otimização Critical)

```mermaid
graph TD
    A[Comando Recebido] --> B{Fila Vazia?}
    B -->|Sim| C[Executar Imediatamente]
    B -->|Não| D[Adicionar à Fila]
    
    C --> E[Enviar para ESP32]
    D --> F[Aguardar Vez]
    F --> G[Processar Próximo]
    G --> E
    
    E --> H[Aguardar '>>>']
    H --> I{Timeout 10s?}
    I -->|Não| J[Resposta Recebida]
    I -->|Sim| K[Erro Timeout]
    
    J --> L[Processar Próximo da Fila]
    K --> M[Log Erro]
    M --> L
    
    L --> N{Fila Vazia?}
    N -->|Sim| O[Idle]
    N -->|Não| G
```

## 🚀 Upload de Arquivo Otimizado

```mermaid
flowchart TD
    A[Selecionar Arquivo] --> B[Verificar Tamanho]
    B --> C{Flash Suficiente?}
    C -->|Não| D[Erro: Espaço Insuficiente]
    C -->|Sim| E[Ler Conteúdo do Arquivo]
    
    E --> F[Entrar Modo Raw ^A]
    F --> G[Preparar Comando Python]
    G --> H[JSON.stringify Content]
    H --> I[Enviar Comando Write]
    
    I --> J[Aguardar Execução]
    J --> K[Sair Modo Raw ^B]
    K --> L[Verificar Arquivo Criado]
    L --> M{Arquivo Existe?}
    
    M -->|Sim| N[Upload Sucesso]
    M -->|Não| O[Erro: Falha na Verificação]
    
    style F fill:#f9f,stroke:#333,stroke-width:2px
    style K fill:#f9f,stroke:#333,stroke-width:2px
    style N fill:#9f9,stroke:#333,stroke-width:2px
    style O fill:#f99,stroke:#333,stroke-width:2px
```

## 🖥️ REPL Terminal Flow

```mermaid
graph LR
    A[User Input] --> B[Terminal Write]
    B --> C[Serial Send]
    C --> D[ESP32 Process]
    D --> E[ESP32 Response]
    E --> F[Serial Receive]
    F --> G[Parser Process]
    G --> H[Terminal Display]
    
    subgraph "Validation Layer"
        I[Validate MicroPython]
        J[Test Basic Commands]
        K[Check Responsiveness]
    end
    
    B --> I
    I --> J
    J --> K
    K --> C
```

## 📁 File System Structure

```text
ESP32 File System (Flash)
├── /boot.py              (Auto-exec on boot)
├── /main.py              (Main application)
├── /lib/                 (Library modules)
│   ├── /wifi_manager.py
│   ├── /sensor_lib.py
│   └── /utils.py
├── /config/              (Configuration)
│   ├── /settings.json
│   └── /network.json
├── /data/                (Application data)
│   ├── /logs/
│   └── /cache/
└── /temp/                (Temporary files)

Memory Layout:
┌─────────────────────────────────────┐ 4MB Flash
│ MicroPython Firmware (~1MB)        │
├─────────────────────────────────────┤
│ File System (~3MB)                  │ ← User accessible
│ ├── User Scripts                    │
│ ├── Libraries                       │
│ └── Data Files                      │
└─────────────────────────────────────┘

RAM Layout (320KB):
┌─────────────────────────────────────┐
│ MicroPython Runtime (~100KB)       │
├─────────────────────────────────────┤
│ User Code & Variables (~220KB)     │ ← Available for code
│ ├── Imported Modules               │
│ ├── Variables & Objects            │
│ └── Execution Stack                │
└─────────────────────────────────────┘
```

## ⚡ Performance Optimizations

```mermaid
mindmap
  root((ESP32 Optimizations))
    Memory Management
      Garbage Collection
      Small Integers Cache
      String Interning
      Buffer Reuse
    Serial Communication  
      Optimal Baud Rates
      Buffer Management
      Command Queuing
      Timeout Handling
    File Operations
      Chunked Uploads
      Integrity Checks
      Flash Wear Leveling
      Compression
    Power Management
      Deep Sleep Support
      CPU Frequency Scaling
      Peripheral Shutdown
      Wake Sources
```

## 🔍 Debug & Monitoring

```mermaid
graph TB
    A[Device Connected] --> B[Monitor Health]
    B --> C[Check Memory]
    B --> D[Check Temperature]
    B --> E[Check Filesystem]
    B --> F[Check Network]
    
    C --> G{RAM < 20%?}
    D --> H{Temp > 75°C?}
    E --> I{Flash < 10%?}
    F --> J{WiFi Connected?}
    
    G -->|Yes| K[Memory Warning]
    H -->|Yes| L[Temperature Warning]
    I -->|Yes| M[Storage Warning]
    J -->|No| N[Network Warning]
    
    K --> O[Log to Output Channel]
    L --> O
    M --> O
    N --> O
    
    O --> P[User Notification]
    P --> Q[Suggest Actions]
```

## 🌐 Network Operations (ESP32 Specific)

```mermaid
sequenceDiagram
    participant ESP32
    participant Router
    participant Internet
    participant MQTT
    
    Note over ESP32: WiFi Connection
    ESP32->>Router: WiFi Connect
    Router-->>ESP32: IP Assigned
    
    Note over ESP32: Network Test
    ESP32->>Internet: Ping Test
    Internet-->>ESP32: Pong Response
    
    Note over ESP32: MQTT Setup
    ESP32->>MQTT: Connect
    MQTT-->>ESP32: Connected
    ESP32->>MQTT: Subscribe Topics
    ESP32->>MQTT: Publish Data
    
    Note over ESP32: Error Handling
    ESP32->>Router: Connection Lost
    ESP32->>ESP32: Auto Reconnect
    ESP32->>Router: Reconnect Attempt
```

## 🔧 Extension Commands Mapping

```text
VS Code Command Palette
│
├── MicroPython: Scan Serial Ports
│   └── deviceManager.listSerialPorts()
│
├── MicroPython: Connect Device  
│   └── deviceManager.connectDevice(port)
│
├── MicroPython: Open REPL
│   └── replManager.openREPL(deviceId)
│
├── MicroPython: Upload File
│   └── deviceManager.uploadFile(deviceId, path)
│
├── MicroPython: Show Memory Info
│   └── deviceManager.getMemoryInfo(deviceId)
│
├── MicroPython: Reset Device
│   └── deviceManager.resetDevice(deviceId)
│
├── MicroPython: List Files
│   └── deviceManager.listFiles(deviceId)
│
└── MicroPython: Download File
    └── deviceManager.downloadFile(deviceId, remotePath)

Context Menu (Device Tree)
│
├── Right-click Device
│   ├── Open REPL
│   ├── Upload File
│   ├── Reset Device
│   ├── Memory Info
│   └── Disconnect
│
└── Right-click File
    ├── Download
    ├── Delete
    └── View Content
```

---

**Nota Técnica:** Todos os diagramas foram otimizados considerando as limitações específicas do ESP32:
- **RAM limitada** (320KB): Uso eficiente de buffers
- **Flash limitado** (4MB): Gestão inteligente de arquivos  
- **CPU dual-core** (240MHz): Processamento paralelo quando possível
- **Comunicação serial**: Baudrates otimizados e timeouts adequados
- **Temperatura operacional**: Monitoramento para evitar throttling
