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
    private commandQueues: Map<string, { command: string, resolve: (output: string) => void, reject: (reason?: any) => void }[]> = new Map();
    private isProcessingQueue: Map<string, boolean> = new Map();

    constructor(private context: vscode.ExtensionContext) {}

    /**
     * Lista e retorna portas seriais disponíveis no sistema
     */
    async listSerialPorts(): Promise<SerialPortInfo[]> {
        try {
            const ports = await SerialPort.list();
            return ports;
        } catch (error) {
            console.error('Erro ao listar portas seriais:', error);
            throw new Error('Falha ao buscar portas seriais.');
        }
    }

    /**
     * Conecta a um dispositivo ESP32 em uma porta específica
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
                this.commandQueues.set(deviceId, []);
                this.isProcessingQueue.set(deviceId, false);

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
                    
                    const versionMatch = responseData.match(/MicroPython v(\d+\.\d+\.\d+)/);
                    resolve(versionMatch ? versionMatch[1] : 'Detectado');
                }
            };

            parser.on('data', onData);

            // Enviar comandos para detectar MicroPython
            serialPort.write('\r\n');
            setTimeout(() => {
                serialPort.write('import sys\r\n');
                setTimeout(() => {
                    serialPort.write('print(sys.implementation)\r\n');
                }, 100);
            }, 200);

            timeout = setTimeout(() => {
                parser.off('data', onData);
                resolve(undefined);
            }, 3000);
        });
    }

    /**
     * Executa comando em um dispositivo específico com fila sequencial
     */
    async executeCommand(deviceId: string, command: string): Promise<string> {
        const connection = this.connections.get(deviceId);
        if (!connection || !connection.isOpen) {
            throw new Error('Dispositivo não conectado');
        }

        return new Promise((resolve, reject) => {
            const queue = this.commandQueues.get(deviceId);
            if (queue) {
                queue.push({ command, resolve, reject });
                if (!this.isProcessingQueue.get(deviceId)) {
                    this.processCommandQueue(deviceId);
                }
            } else {
                reject(new Error('Fila de comandos não encontrada para o dispositivo.'));
            }
        });
    }

    /**
     * Processa a fila de comandos para um dispositivo
     */
    private async processCommandQueue(deviceId: string): Promise<void> {
        const queue = this.commandQueues.get(deviceId);
        if (!queue || queue.length === 0) {
            this.isProcessingQueue.set(deviceId, false);
            return;
        }

        this.isProcessingQueue.set(deviceId, true);
        const { command, resolve, reject } = queue.shift()!;
        
        const connection = this.connections.get(deviceId);
        const parser = this.parsers.get(deviceId);

        if (!connection || !parser) {
            reject(new Error('Conexão ou parser não encontrado.'));
            this.processCommandQueue(deviceId);
            return;
        }

        let output = '';
        const onData = (data: string) => {
            output += data;
            if (data.includes('>>>') || data.includes('...')) {
                cleanupAndResolve();
            }
        };

        const timeout = setTimeout(() => {
            cleanupAndReject(new Error(`Timeout de 10s na execução do comando: ${command.substring(0, 20)}...`));
        }, 10000);

        const cleanupAndResolve = () => {
            clearTimeout(timeout);
            parser.off('data', onData);
            resolve(output);
            this.processCommandQueue(deviceId);
        };

        const cleanupAndReject = (error: Error) => {
            clearTimeout(timeout);
            parser.off('data', onData);
            reject(error);
            this.processCommandQueue(deviceId);
        };

        parser.on('data', onData);

        connection.write(command + '\r\n', (err) => {
            if (err) {
                cleanupAndReject(err);
            }
        });
    }

    /**
     * Upload de arquivo para ESP32
     */
    async uploadFile(deviceId: string, localPath: string, remotePath?: string): Promise<void> {
        const outputChannel = this.outputChannels.get(deviceId);
        if (!outputChannel) {
            throw new Error('Dispositivo não conectado');
        }

        try {
            const fileContent = fs.readFileSync(localPath, 'utf8');
            const fileName = remotePath || path.basename(localPath);
            
            outputChannel.show();
            outputChannel.appendLine(`\n=== Upload ${fileName} ===`);
            
            await this.executeCommand(deviceId, '\x01'); // Raw mode
            
            const writeCommand = `
import ujson
with open('${fileName}', 'w') as f:
    f.write(ujson.loads(${JSON.stringify(JSON.stringify(fileContent))}))
`;
            await this.executeCommand(deviceId, writeCommand);
            await this.executeCommand(deviceId, '\x02'); // Exit raw mode
            
            const checkOutput = await this.executeCommand(deviceId, `import os; print('${fileName}' in os.listdir())`);
            
            if (checkOutput.includes('True')) {
                outputChannel.appendLine(`=== Upload concluído: ${fileName} ===\n`);
            } else {
                throw new Error('Falha na verificação do upload do arquivo.');
            }
            
        } catch (error) {
            await this.executeCommand(deviceId, '\x02');
            throw new Error(`Erro no upload: ${error}`);
        }
    }

    /**
     * Download de arquivo do ESP32
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
                        fs.writeFileSync(localPath, fileContent);
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                    return;
                }
                
                if (isCapturingContent) {
                    fileContent += data;
                }
            };

            parser.on('data', onData);

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
     * Deleta arquivo do ESP32
     */
    async deleteFile(deviceId: string, filePath: string, isDirectory: boolean = false): Promise<void> {
        const command = isDirectory 
            ? `import os; os.rmdir('${filePath}')`
            : `import os; os.remove('${filePath}')`;
        
        await this.executeCommand(deviceId, command);
    }

    /**
     * Lista arquivos do dispositivo
     */
    async listFiles(deviceId: string, dirPath: string = '/'): Promise<void> {
        const outputChannel = this.outputChannels.get(deviceId);
        if (!outputChannel) {
            throw new Error('Dispositivo não conectado');
        }

        outputChannel.show();
        outputChannel.appendLine(`\n=== Arquivos em ${dirPath} ===`);
        
        const command = `
import os
try:
    files = os.listdir('${dirPath}')
    for f in sorted(files):
        try:
            stat = os.stat('${dirPath}' + f)
            size = stat[6]
            print(f"{f:20} {size:8} bytes")
        except:
            print(f"{f:20} <dir>")
except Exception as e:
    print("Erro:", e)
`;
        
        await this.executeCommand(deviceId, command);
        outputChannel.appendLine('=== Fim da listagem ===\n');
    }

    /**
     * Obtém informações de memória
     */
    async getMemoryInfo(deviceId: string): Promise<void> {
        const outputChannel = this.outputChannels.get(deviceId);
        if (!outputChannel) {
            throw new Error('Dispositivo não conectado');
        }
        
        const command = `
import gc
gc.collect()
free = gc.mem_free()
alloc = gc.mem_alloc()
total = free + alloc
print("Memória Total: {:.2f} KB".format(total/1024))
print("Memória Usada: {:.2f} KB".format(alloc/1024))
print("Memória Livre: {:.2f} KB ({:.2f}%)".format(free/1024, free/total*100))
`;
        const output = await this.executeCommand(deviceId, command);
        
        outputChannel.show();
        outputChannel.appendLine('\n=== Informações de Memória ===');
        const cleanOutput = output.split('\n').slice(1, -1).join('\n');
        outputChannel.appendLine(cleanOutput);
        outputChannel.appendLine('============================\n');
    }

    /**
     * Reset do dispositivo
     */
    async resetDevice(deviceId: string): Promise<void> {
        const outputChannel = this.outputChannels.get(deviceId);
        if (!outputChannel) {
            throw new Error('Dispositivo não conectado');
        }
        
        outputChannel.appendLine('Enviando comando de soft reset (Ctrl+D)...');
        await this.executeCommand(deviceId, '\x04');
        outputChannel.appendLine('Reset enviado.');
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
        this.commandQueues.delete(deviceId);
        this.isProcessingQueue.delete(deviceId);

        vscode.window.showInformationMessage(`Desconectado do ${device.name}`);
    }

    /**
     * Desconecta todos os dispositivos
     */
    async disconnectAll(): Promise<void> {
        for (const deviceId of this.devices.keys()) {
            await this.disconnectDevice(deviceId);
        }
    }

    /**
     * Obtém dispositivo por ID
     */
    getDevice(deviceId: string): ESP32Device | undefined {
        return this.devices.get(deviceId);
    }

    /**
     * Obtém todos os dispositivos conectados
     */
    getConnectedDevices(): ESP32Device[] {
        return Array.from(this.devices.values());
    }

    /**
     * Obtém canal de saída de um dispositivo
     */
    getOutputChannel(deviceId: string): vscode.OutputChannel | undefined {
        return this.outputChannels.get(deviceId);
    }

    /**
     * Obtém parser de um dispositivo
     */
    getParser(deviceId: string): ReadlineParser | undefined {
        return this.parsers.get(deviceId);
    }

    /**
     * Limpa recursos ao desativar a extensão
     */
    dispose(): void {
        this.disconnectAll();
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
