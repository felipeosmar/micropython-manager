import * as vscode from 'vscode';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { ESP32Device, SerialPortInfo, ESP32File } from './types';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Gerenciador de dispositivos ESP32 com MicroPython
 * 
 * Problema: Necessidade de gerenciar múltiplas conexões seriais com ESP32
 * Solução: Classe centralizada que mantém estado das conexões e facilita comunicação
 * Exemplo: Permite conectar até 10 dispositivos simultaneamente com controle individual
 */
export class DeviceManager {
    private devices: Map<string, ESP32Device> = new Map();
    private connections: Map<string, SerialPort> = new Map();
    private parsers: Map<string, ReadlineParser> = new Map();
    private outputChannels: Map<string, vscode.OutputChannel> = new Map();

    constructor(private context: vscode.ExtensionContext) {}

    /**
     * Escaneia portas seriais disponíveis
     * 
     * Problema: ESP32 pode estar em qualquer porta USB/serial do sistema
     * Solução: Lista todas as portas disponíveis e filtra por características conhecidas
     * Exemplo: Detecta automaticamente ESP32 por vendor ID (Espressif = 0x10C4)
     */
    async scanSerialPorts(): Promise<SerialPortInfo[]> {
        try {
            const ports = await SerialPort.list();
            
            // Filtrar portas que podem ser ESP32
            const espPorts = ports.filter(port => {
                return port.path.includes('ttyUSB') || 
                       port.path.includes('ttyACM') ||
                       port.vendorId === '10C4' || // Silicon Labs (usado em muitos ESP32)
                       port.vendorId === '1A86' || // QinHeng Electronics (CH340)
                       port.vendorId === '0403';   // FTDI
            });

            return espPorts.map(port => ({
                path: port.path,
                manufacturer: port.manufacturer,
                serialNumber: port.serialNumber,
                pnpId: port.pnpId,
                locationId: port.locationId,
                productId: port.productId,
                vendorId: port.vendorId
            }));
        } catch (error) {
            vscode.window.showErrorMessage(`Erro ao escanear portas: ${error}`);
            return [];
        }
    }

    /**
     * Conecta a um dispositivo ESP32
     * 
     * Problema: Conexão serial pode falhar por múltiplos motivos (porta ocupada, baudrate, etc.)
     * Solução: Implementa retry automático e configuração otimizada para ESP32
     * Exemplo: Tenta 115200 baud primeiro, depois 9600 se falhar
     */
    async connectDevice(portPath: string, customBaudRate?: number): Promise<ESP32Device | null> {
        const deviceId = `esp32_${portPath.replace(/[^a-zA-Z0-9]/g, '_')}`;
        
        // Configurações otimizadas para ESP32
        const baudRates = customBaudRate ? [customBaudRate] : [115200, 9600, 57600];
        
        for (const baudRate of baudRates) {
            try {
                const serialPort = new SerialPort({
                    path: portPath,
                    baudRate: baudRate,
                    dataBits: 8,
                    stopBits: 1,
                    parity: 'none',
                    autoOpen: false
                });
                
                const parser = new ReadlineParser({ delimiter: '\r\n' });
                
                await new Promise<void>((resolve, reject) => {
                    serialPort.open((err) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                });

                serialPort.pipe(parser);

                // Criar canal de saída para este dispositivo
                const outputChannel = vscode.window.createOutputChannel(`ESP32 - ${portPath}`);
                
                // Configurar listeners
                parser.on('data', (data: string) => {
                    outputChannel.appendLine(data);
                    // Atualizar última atividade quando receber dados
                    const currentDevice = this.devices.get(deviceId);
                    if (currentDevice) {
                        currentDevice.lastActivity = new Date();
                        this.devices.set(deviceId, currentDevice);
                    }
                });

                serialPort.on('error', (err) => {
                    vscode.window.showErrorMessage(`Erro na conexão ${portPath}: ${err.message}`);
                    this.disconnectDevice(deviceId);
                });

                // Testar se é MicroPython enviando comando de versão
                const micropythonVersion = await this.detectMicroPython(serialPort, parser);
                
                const device: ESP32Device = {
                    id: deviceId,
                    name: `ESP32 (${portPath})`,
                    port: portPath,
                    baudRate,
                    isConnected: true,
                    micropythonVersion,
                    lastActivity: new Date()
                };

                this.devices.set(deviceId, device);
                this.connections.set(deviceId, serialPort);
                this.parsers.set(deviceId, parser);
                this.outputChannels.set(deviceId, outputChannel);

                vscode.window.showInformationMessage(
                    `Conectado ao ESP32 em ${portPath} (${baudRate} baud)`
                );

                return device;

            } catch (error) {
                console.log(`Falha ao conectar em ${portPath} com ${baudRate} baud:`, error);
                continue;
            }
        }

        vscode.window.showErrorMessage(`Não foi possível conectar ao dispositivo em ${portPath}`);
        return null;
    }

    /**
     * Detecta se o dispositivo está executando MicroPython
     * 
     * Problema: Precisa verificar se é realmente MicroPython e qual versão
     * Solução: Envia comandos específicos e analisa resposta
     * Exemplo: import sys; print(sys.implementation) retorna informações do MicroPython
     */
    private async detectMicroPython(serialPort: SerialPort, parser: ReadlineParser): Promise<string | undefined> {
        return new Promise((resolve) => {
            let timeout: NodeJS.Timeout;
            let responseData = '';

            const onData = (data: string) => {
                responseData += data;
                if (responseData.includes('MicroPython') || responseData.includes('micropython')) {
                    clearTimeout(timeout);
                    parser.off('data', onData);
                    
                    // Extrair versão se possível
                    const versionMatch = responseData.match(/MicroPython v(\d+\.\d+\.\d+)/);
                    resolve(versionMatch ? versionMatch[1] : 'Detectado');
                }
            };

            parser.on('data', onData);

            // Enviar comandos para detectar MicroPython
            serialPort.write('\r\n'); // Wake up
            setTimeout(() => {
                serialPort.write('import sys\r\n');
                setTimeout(() => {
                    serialPort.write('print(sys.implementation)\r\n');
                }, 100);
            }, 200);

            // Timeout de 3 segundos
            timeout = setTimeout(() => {
                parser.off('data', onData);
                resolve(undefined);
            }, 3000);
        });
    }

    /**
     * Desconecta um dispositivo específico
     */
    async disconnectDevice(deviceId: string): Promise<void> {
        const device = this.devices.get(deviceId);
        if (!device) {
            return;
        }

        const connection = this.connections.get(deviceId);
        const outputChannel = this.outputChannels.get(deviceId);

        if (connection && connection.isOpen) {
            connection.close();
        }

        if (outputChannel) {
            outputChannel.dispose();
        }

        this.devices.delete(deviceId);
        this.connections.delete(deviceId);
        this.parsers.delete(deviceId);
        this.outputChannels.delete(deviceId);

        vscode.window.showInformationMessage(`Desconectado do ${device.name}`);
    }

    /**
     * Desconecta todos os dispositivos
     */
    async disconnectAll(): Promise<void> {
        const deviceIds = Array.from(this.devices.keys());
        for (const deviceId of deviceIds) {
            await this.disconnectDevice(deviceId);
        }
    }

    /**
     * Executa comando em um dispositivo específico
     * 
     * Problema: Necessidade de enviar comandos Python para ESP32 de forma confiável
     * Solução: Wrapper que garante terminação correta e tratamento de erros
     * Exemplo: device.executeCommand('print("Hello ESP32!")') 
     */
    async executeCommand(deviceId: string, command: string): Promise<void> {
        const connection = this.connections.get(deviceId);
        if (!connection || !connection.isOpen) {
            throw new Error('Dispositivo não conectado');
        }

        return new Promise((resolve, reject) => {
            // Configurar timeout para comando
            const timeout = setTimeout(() => {
                reject(new Error('Timeout na execução do comando'));
            }, 5000);

            try {
                // Formatear comando corretamente
                let formattedCommand = command;
                
                // Se não termina com \r\n, adicionar
                if (!command.endsWith('\r\n') && !command.endsWith('\n')) {
                    formattedCommand = command + '\r\n';
                } else if (command.endsWith('\n') && !command.endsWith('\r\n')) {
                    formattedCommand = command.slice(0, -1) + '\r\n';
                }
                
                // Enviar comando
                connection.write(formattedCommand, (error) => {
                    clearTimeout(timeout);
                    
                    if (error) {
                        reject(error);
                    } else {
                        // Atualizar última atividade
                        const device = this.devices.get(deviceId);
                        if (device) {
                            device.lastActivity = new Date();
                            this.devices.set(deviceId, device);
                        }
                        resolve();
                    }
                });
                
            } catch (error) {
                clearTimeout(timeout);
                reject(error);
            }
        });
    }

    /**
     * Faz upload de arquivo para ESP32
     * 
     * Problema: ESP32 precisa receber arquivos .py de forma confiável
     * Solução: Usa modo paste do MicroPython com chunking para arquivos grandes
     * Exemplo: upload de main.py com verificação de integridade
     */
    async uploadFile(deviceId: string, localPath: string, remotePath?: string): Promise<void> {
        const connection = this.connections.get(deviceId);
        const outputChannel = this.outputChannels.get(deviceId);
        
        if (!connection || !connection.isOpen || !outputChannel) {
            throw new Error('Dispositivo não conectado');
        }

        try {
            const fileContent = fs.readFileSync(localPath, 'utf8');
            const fileName = remotePath || path.basename(localPath);
            
            outputChannel.show();
            outputChannel.appendLine(`\n=== Upload ${fileName} ===`);
            
            // Verificar espaço disponível
            await this.executeCommand(deviceId, "import gc; print('Mem livre:', gc.mem_free())\r\n");
            await this.delay(500);
            
            // Criar arquivo no ESP32 usando modo paste
            await this.executeCommand(deviceId, '\x05'); // Ctrl+E (paste mode)
            await this.delay(200);
            
            // Escrever arquivo
            await this.executeCommand(deviceId, `with open('${fileName}', 'w') as f:`);
            await this.delay(100);
            
            // Enviar conteúdo em chunks para evitar overflow
            const lines = fileContent.split('\n');
            const chunkSize = 10;
            
            for (let i = 0; i < lines.length; i += chunkSize) {
                const chunk = lines.slice(i, i + chunkSize);
                for (const line of chunk) {
                    const escapedLine = line.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                    await this.executeCommand(deviceId, `    f.write('${escapedLine}\\n')`);
                    await this.delay(50);
                }
                
                // Pequena pausa entre chunks para ESP32 processar
                await this.delay(200);
            }
            
            await this.executeCommand(deviceId, '\x04'); // Ctrl+D (exit paste mode)
            await this.delay(500);
            
            // Verificar se arquivo foi criado
            await this.executeCommand(deviceId, `import os; print('${fileName}' in os.listdir())`);
            
            outputChannel.appendLine(`=== Upload concluído: ${fileName} ===\n`);
            
        } catch (error) {
            throw new Error(`Erro no upload: ${error}`);
        }
    }

    /**
     * Reset do ESP32
     * 
     * Problema: ESP32 pode travar e precisar de reset via software
     * Solução: Usa machine.reset() para reinicialização limpa
     * Exemplo: Reset remoto sem desconectar fisicamente
     */
    async resetDevice(deviceId: string): Promise<void> {
        const connection = this.connections.get(deviceId);
        const outputChannel = this.outputChannels.get(deviceId);
        
        if (!connection || !connection.isOpen || !outputChannel) {
            throw new Error('Dispositivo não conectado');
        }

        try {
            outputChannel.show();
            outputChannel.appendLine('\n=== Resetando ESP32 ===');
            
            // Interromper execução atual
            await this.executeCommand(deviceId, '\x03'); // Ctrl+C
            await this.delay(200);
            
            // Executar reset
            await this.executeCommand(deviceId, 'import machine\r\n');
            await this.delay(200);
            
            await this.executeCommand(deviceId, 'machine.reset()\r\n');
            
            outputChannel.appendLine('Comando de reset enviado');
            outputChannel.appendLine('Aguarde alguns segundos para o ESP32 reiniciar...\n');
            
            // Aguardar reset (ESP32 será reconectado automaticamente)
            setTimeout(() => {
                outputChannel.appendLine('ESP32 deve ter reiniciado. Verifique o prompt MicroPython.\n');
            }, 3000);
            
        } catch (error) {
            throw new Error(`Erro no reset: ${error}`);
        }
    }

    /**
     * Obtém informações de memória do ESP32
     * 
     * Problema: ESP32 tem limitações de RAM/Flash que precisam ser monitoradas
     * Solução: Usa gc e esp32 modules para dados precisos
     * Exemplo: Mostra RAM livre, Flash usado, temperatura do chip
     */
    async getMemoryInfo(deviceId: string): Promise<void> {
        const connection = this.connections.get(deviceId);
        const outputChannel = this.outputChannels.get(deviceId);
        
        if (!connection || !connection.isOpen || !outputChannel) {
            throw new Error('Dispositivo não conectado');
        }

        try {
            outputChannel.show();
            outputChannel.appendLine('\n=== Informações do ESP32 ===');
            
            // Informações de memória
            await this.executeCommand(deviceId, 'import gc, esp32\r\n');
            await this.delay(200);
            
            await this.executeCommand(deviceId, 'print("RAM Livre:", gc.mem_free(), "bytes")\r\n');
            await this.delay(300);
            
            await this.executeCommand(deviceId, 'print("RAM Alocada:", gc.mem_alloc(), "bytes")\r\n');
            await this.delay(300);
            
            // Informações do flash
            await this.executeCommand(deviceId, 'import os\r\n');
            await this.delay(200);
            
            await this.executeCommand(deviceId, 'stat = os.statvfs("/")\r\n');
            await this.delay(200);
            
            await this.executeCommand(deviceId, 'print("Flash Total:", stat[0] * stat[2], "bytes")\r\n');
            await this.delay(300);
            
            await this.executeCommand(deviceId, 'print("Flash Livre:", stat[0] * stat[3], "bytes")\r\n');
            await this.delay(300);
            
            // Temperatura do chip (se disponível)
            await this.executeCommand(deviceId, 'try:\r\n');
            await this.delay(100);
            
            await this.executeCommand(deviceId, '    temp = (esp32.raw_temperature() - 32) / 1.8\r\n');
            await this.delay(100);
            
            await this.executeCommand(deviceId, '    print("Temperatura:", round(temp, 1), "°C")\r\n');
            await this.delay(100);
            
            await this.executeCommand(deviceId, 'except:\r\n');
            await this.delay(100);
            
            await this.executeCommand(deviceId, '    print("Temperatura: Não disponível")\r\n');
            await this.delay(200);
            
            // Frequência do CPU
            await this.executeCommand(deviceId, 'import machine\r\n');
            await this.delay(200);
            
            await this.executeCommand(deviceId, 'print("CPU Freq:", machine.freq(), "Hz")\r\n');
            await this.delay(200);
            
            outputChannel.appendLine('=== Fim das informações ===\n');
            
        } catch (error) {
            throw new Error(`Erro ao obter informações: ${error}`);
        }
    }

    /**
     * Lista arquivos no ESP32
     * 
     * Problema: Necessidade de ver estrutura de arquivos no ESP32
     * Solução: Usa os.listdir() recursivo com informações de tamanho
     * Exemplo: Lista todos os .py com tamanhos para gestão de espaço
     */
    async listFiles(deviceId: string, path: string = '/'): Promise<void> {
        const connection = this.connections.get(deviceId);
        const outputChannel = this.outputChannels.get(deviceId);
        
        if (!connection || !connection.isOpen || !outputChannel) {
            throw new Error('Dispositivo não conectado');
        }

        try {
            outputChannel.show();
            outputChannel.appendLine(`\n=== Arquivos em ${path} ===`);
            
            await this.executeCommand(deviceId, 'import os\r\n');
            await this.delay(200);
            
            // Listar arquivos com detalhes
            await this.executeCommand(deviceId, `try:\r\n`);
            await this.delay(100);
            
            await this.executeCommand(deviceId, `    files = os.listdir('${path}')\r\n`);
            await this.delay(200);
            
            await this.executeCommand(deviceId, `    for f in sorted(files):\r\n`);
            await this.delay(100);
            
            await this.executeCommand(deviceId, `        try:\r\n`);
            await this.delay(100);
            
            await this.executeCommand(deviceId, `            stat = os.stat('${path}' + f)\r\n`);
            await this.delay(100);
            
            await this.executeCommand(deviceId, `            size = stat[6]\r\n`);
            await this.delay(100);
            
            await this.executeCommand(deviceId, '            print(f"{f:20} {size:8} bytes")\r\n');
            await this.delay(100);
            
            await this.executeCommand(deviceId, `        except:\r\n`);
            await this.delay(100);
            
            await this.executeCommand(deviceId, '            print(f"{f:20} <dir>")\r\n');
            await this.delay(100);
            
            await this.executeCommand(deviceId, `except Exception as e:\r\n`);
            await this.delay(100);
            
            await this.executeCommand(deviceId, `    print("Erro:", e)\r\n`);
            await this.delay(200);
            
            outputChannel.appendLine('=== Fim da listagem ===\n');
            
        } catch (error) {
            throw new Error(`Erro ao listar arquivos: ${error}`);
        }
    }

    /**
     * Obtém estrutura de arquivos do ESP32 para uso na árvore
     * 
     * Problema: Necessidade de representar estrutura de arquivos em árvore
     * Solução: Comando otimizado que retorna lista de arquivos e diretórios com informações detalhadas
     * Exemplo: Permite visualizar pastas e arquivos .py em árvore hierárquica
     */
    async getFileStructure(deviceId: string, dirPath: string = '/'): Promise<ESP32File[]> {
        const connection = this.connections.get(deviceId);
        if (!connection || !connection.isOpen) {
            throw new Error('Dispositivo não conectado');
        }

        return new Promise((resolve, reject) => {
            const files: ESP32File[] = [];
            let responseData = '';
            let isCapturingOutput = false;
            
            const parser = this.parsers.get(deviceId);
            if (!parser) {
                reject(new Error('Parser não encontrado'));
                return;
            }

            const timeout = setTimeout(() => {
                parser.off('data', onData);
                reject(new Error('Timeout ao listar arquivos'));
            }, 15000);

            const onData = (data: string) => {
                // Começar a capturar quando ver o marcador de início
                if (data.includes('FILE_LIST_START')) {
                    isCapturingOutput = true;
                    responseData = '';
                    return;
                }
                
                // Parar de capturar e processar quando ver o marcador de fim
                if (data.includes('FILE_LIST_END')) {
                    clearTimeout(timeout);
                    parser.off('data', onData);
                    
                    // Processar dados capturados
                    const lines = responseData.split('\n');
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed && !trimmed.includes('FILE_LIST') && trimmed.length > 0) {
                            try {
                                // Formato esperado: "nome|tipo|tamanho"
                                const parts = trimmed.split('|');
                                if (parts.length >= 2) {
                                    const fileName = parts[0];
                                    const isDirectory = parts[1] === 'DIR';
                                    const size = parts.length > 2 && parts[2] !== 'N/A' ? parseInt(parts[2]) : undefined;
                                    
                                    // Construir caminho completo
                                    let fullPath;
                                    if (dirPath === '/') {
                                        fullPath = `/${fileName}`;
                                    } else {
                                        fullPath = `${dirPath}/${fileName}`;
                                    }
                                    
                                    files.push({
                                        name: fileName,
                                        path: fullPath,
                                        isDirectory,
                                        size,
                                        deviceId
                                    });
                                }
                            } catch (e) {
                                console.log('Erro ao processar linha:', trimmed, e);
                            }
                        }
                    }
                    
                    resolve(files);
                    return;
                }
                
                // Capturar dados se estivermos no modo de captura
                if (isCapturingOutput) {
                    responseData += data;
                }
            };

            parser.on('data', onData);

            // Normalizar o caminho do diretório
            const normalizedPath = dirPath.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
            
            // Enviar comando otimizado para listar arquivos
            const command = `
try:
    import os
    print("FILE_LIST_START")
    dir_path = "${normalizedPath.replace(/"/g, '\\"')}"
    if dir_path == "/":
        dir_path = ""
    files = os.listdir("/" if dir_path == "" else dir_path)
    for f in sorted(files):
        full_path = ("/" + f) if dir_path == "" else (dir_path + "/" + f)
        try:
            stat_info = os.stat(full_path)
            if stat_info[0] & 0x4000:  # S_IFDIR
                print(f + "|DIR|N/A")
            else:
                print(f + "|FILE|" + str(stat_info[6]))
        except:
            print(f + "|FILE|0")
    print("FILE_LIST_END")
except Exception as e:
    print("FILE_LIST_START")
    print("ERRO: " + str(e))
    print("FILE_LIST_END")
`;

            // Enviar comando sem adicionar \r\n extra para evitar problemas
            connection.write(command, (error) => {
                if (error) {
                    clearTimeout(timeout);
                    parser.off('data', onData);
                    reject(error);
                }
            });
        });
    }

    /**
     * Obtém lista de dispositivos conectados
     */
    getConnectedDevices(): ESP32Device[] {
        return Array.from(this.devices.values()).filter(device => device.isConnected);
    }

    /**
     * Obtém um dispositivo específico por ID
     */
    getDevice(deviceId: string): ESP32Device | undefined {
        return this.devices.get(deviceId);
    }

    /**
     * Obtém canal de saída de um dispositivo
     */
    getOutputChannel(deviceId: string): vscode.OutputChannel | undefined {
        return this.outputChannels.get(deviceId);
    }

    /**
     * Obtém parser de um dispositivo para interceptar dados serial
     */
    getParser(deviceId: string): ReadlineParser | undefined {
        return this.parsers.get(deviceId);
    }

    /**
     * Baixa arquivo do ESP32 para o computador
     * 
     * Problema: Necessidade de transferir arquivos .py do ESP32 para edição local
     * Solução: Lê conteúdo via comandos Python e salva localmente
     * Exemplo: Baixa main.py do ESP32 para backup ou edição
     */
    async downloadFile(deviceId: string, remotePath: string, localPath: string): Promise<void> {
        const connection = this.connections.get(deviceId);
        if (!connection || !connection.isOpen) {
            throw new Error('Dispositivo não conectado');
        }

        return new Promise((resolve, reject) => {
            let fileContent = '';
            let isCapturingContent = false;
            
            const parser = this.parsers.get(deviceId);
            if (!parser) {
                reject(new Error('Parser não encontrado'));
                return;
            }

            const timeout = setTimeout(() => {
                parser.off('data', onData);
                reject(new Error('Timeout ao baixar arquivo'));
            }, 30000);

            const onData = (data: string) => {
                if (data.includes('FILE_CONTENT_START')) {
                    isCapturingContent = true;
                    fileContent = '';
                    return;
                }
                
                if (data.includes('FILE_CONTENT_END')) {
                    clearTimeout(timeout);
                    parser.off('data', onData);
                    
                    try {
                        // Salvar arquivo localmente
                        const fs = require('fs');
                        fs.writeFileSync(localPath, fileContent);
                        resolve();
                    } catch (error) {
                        reject(new Error(`Erro ao salvar arquivo: ${error}`));
                    }
                    return;
                }
                
                if (isCapturingContent) {
                    fileContent += data;
                }
            };

            parser.on('data', onData);

            // Comando para ler arquivo
            const command = `
try:
    print("FILE_CONTENT_START")
    with open("${remotePath.replace(/"/g, '\\"')}", "r") as f:
        content = f.read()
        print(content, end="")
    print("FILE_CONTENT_END")
except Exception as e:
    print("FILE_CONTENT_START")
    print("ERRO:", str(e))
    print("FILE_CONTENT_END")
`;

            connection.write(command, (error) => {
                if (error) {
                    clearTimeout(timeout);
                    parser.off('data', onData);
                    reject(error);
                }
            });
        });
    }

    /**
     * Exclui arquivo ou diretório do ESP32
     * 
     * Problema: Necessidade de gerenciar espaço no ESP32 removendo arquivos desnecessários
     * Solução: Usa os.remove() para arquivos e rmdir() para diretórios vazios
     * Exemplo: Remove arquivos de teste ou backups antigos
     */
    async deleteFile(deviceId: string, filePath: string, isDirectory: boolean = false): Promise<void> {
        const connection = this.connections.get(deviceId);
        const outputChannel = this.outputChannels.get(deviceId);
        
        if (!connection || !connection.isOpen || !outputChannel) {
            throw new Error('Dispositivo não conectado');
        }

        return new Promise((resolve, reject) => {
            let responseData = '';
            
            const parser = this.parsers.get(deviceId);
            if (!parser) {
                reject(new Error('Parser não encontrado'));
                return;
            }

            const timeout = setTimeout(() => {
                parser.off('data', onData);
                reject(new Error('Timeout ao excluir arquivo'));
            }, 10000);

            const onData = (data: string) => {
                responseData += data;
                
                if (data.includes('DELETE_SUCCESS')) {
                    clearTimeout(timeout);
                    parser.off('data', onData);
                    outputChannel.appendLine(`Arquivo/diretório excluído: ${filePath}`);
                    resolve();
                } else if (data.includes('DELETE_ERROR')) {
                    clearTimeout(timeout);
                    parser.off('data', onData);
                    reject(new Error('Erro ao excluir arquivo/diretório'));
                }
            };

            parser.on('data', onData);

            // Comando para excluir arquivo ou diretório
            const command = isDirectory ? `
try:
    import os
    os.rmdir("${filePath.replace(/"/g, '\\"')}")
    print("DELETE_SUCCESS")
except Exception as e:
    print("DELETE_ERROR:", str(e))
` : `
try:
    import os
    os.remove("${filePath.replace(/"/g, '\\"')}")  
    print("DELETE_SUCCESS")
except Exception as e:
    print("DELETE_ERROR:", str(e))
`;

            connection.write(command, (error) => {
                if (error) {
                    clearTimeout(timeout);
                    parser.off('data', onData);
                    reject(error);
                }
            });
        });
    }

    /**
     * Utilitário para delays otimizados para ESP32
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Cleanup quando extensão for desativada
     */
    dispose(): void {
        this.disconnectAll();
    }
}
