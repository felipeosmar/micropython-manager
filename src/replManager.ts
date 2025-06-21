import * as vscode from 'vscode';
import { ESP32Device } from './types';
import { DeviceManager } from './deviceManager';

/**
 * Gerenciador de REPL (Read-Eval-Print Loop) para MicroPython
 * 
 * Problema: Necessidade de terminal interativo para enviar comandos Python para ESP32
 * Solução: Terminal customizado que se comunica com dispositivo serial via pseudoterminal
 * Exemplo: Permite executar "print('Hello')" e ver resultado imediatamente
 */
export class REPLManager {
    private activeREPLs: Map<string, vscode.Terminal> = new Map();
    
    constructor(private deviceManager: DeviceManager) {}

    /**
     * Abre REPL para um dispositivo específico
     * 
     * Problema: ESP32 precisa de comunicação bidirecional para desenvolvimento interativo
     * Solução: Terminal que redireciona entrada/saída para porta serial
     * Exemplo: Terminal mostra ">>>" do MicroPython e permite digitação de comandos
     */
    async openREPL(deviceId: string): Promise<void> {
        const device = this.deviceManager.getDevice(deviceId);
        if (!device || !device.isConnected) {
            vscode.window.showErrorMessage('Dispositivo não conectado');
            return;
        }

        // Verificar se já existe REPL ativo para este dispositivo
        const existingREPL = this.activeREPLs.get(deviceId);
        if (existingREPL) {
            existingREPL.show();
            return;
        }

        try {
            // Criar terminal customizado para REPL
            const terminal = vscode.window.createTerminal({
                name: `MicroPython REPL - ${device.name}`,
                pty: new MicroPythonPseudoTerminal(device, this.deviceManager)
            });

            this.activeREPLs.set(deviceId, terminal);
            terminal.show();

            // Limpar referência quando terminal for fechado
            vscode.window.onDidCloseTerminal((closedTerminal) => {
                if (closedTerminal === terminal) {
                    this.activeREPLs.delete(deviceId);
                }
            });

        } catch (error) {
            vscode.window.showErrorMessage(`Erro ao abrir REPL: ${error}`);
        }
    }

    /**
     * Executa script Python em um dispositivo
     * 
     * Problema: Necessidade de enviar arquivos .py completos para ESP32
     * Solução: Lê arquivo local e envia linha por linha para o dispositivo
     * Exemplo: Executa main.py no ESP32 e mostra resultado no terminal
     */
    async runScript(deviceId: string, scriptPath?: string): Promise<void> {
        const device = this.deviceManager.getDevice(deviceId);
        if (!device || !device.isConnected) {
            vscode.window.showErrorMessage('Dispositivo não conectado');
            return;
        }

        let filePath: string;
        
        if (scriptPath) {
            filePath = scriptPath;
        } else {
            // Perguntar ao usuário qual arquivo executar
            const fileUri = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'Python Files': ['py'],
                    'All Files': ['*']
                },
                title: 'Selecionar script Python para executar'
            });

            if (!fileUri || fileUri.length === 0) {
                return;
            }

            filePath = fileUri[0].fsPath;
        }

        try {
            // Ler conteúdo do arquivo
            const document = await vscode.workspace.openTextDocument(filePath);
            const scriptContent = document.getText();

            // Executar script
            await this.executeScript(deviceId, scriptContent, filePath);

        } catch (error) {
            vscode.window.showErrorMessage(`Erro ao executar script: ${error}`);
        }
    }

    /**
     * Executa conteúdo de script no dispositivo
     * 
     * Problema: MicroPython precisa receber código de forma controlada
     * Solução: Envia script usando modo paste do MicroPython (Ctrl+E)
     * Exemplo: Usa comandos especiais para enviar código multi-linha com segurança
     */
    private async executeScript(deviceId: string, scriptContent: string, fileName: string): Promise<void> {
        const outputChannel = this.deviceManager.getOutputChannel(deviceId);
        if (!outputChannel) {
            throw new Error('Canal de saída não encontrado');
        }

        outputChannel.show();
        outputChannel.appendLine(`\n=== Executando ${fileName} ===`);

        try {
            // Entrar no modo paste do MicroPython (Ctrl+E)
            await this.deviceManager.executeCommand(deviceId, '\x05'); // Ctrl+E
            await this.sleep(100);

            // Enviar conteúdo do script
            const lines = scriptContent.split('\n');
            for (const line of lines) {
                if (line.trim()) {
                    await this.deviceManager.executeCommand(deviceId, line);
                    await this.sleep(50); // Pequena pausa entre linhas
                }
            }

            // Sair do modo paste (Ctrl+D)
            await this.sleep(200);
            await this.deviceManager.executeCommand(deviceId, '\x04'); // Ctrl+D

            outputChannel.appendLine('=== Script executado com sucesso ===\n');

        } catch (error) {
            outputChannel.appendLine(`=== Erro na execução: ${error} ===\n`);
            throw error;
        }
    }

    /**
     * Utilitário para pausas entre comandos
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Fecha todos os REPLs ativos
     */
    closeAllREPLs(): void {
        for (const terminal of this.activeREPLs.values()) {
            terminal.dispose();
        }
        this.activeREPLs.clear();
    }
}

/**
 * Pseudoterminal customizado para comunicação com MicroPython
 * 
 * Problema: VSCode Terminal API não suporta comunicação serial diretamente
 * Solução: Implementa Pseudoterminal que bridge entre terminal e porta serial
 * Exemplo: Redireciona teclas digitadas para ESP32 e mostra respostas no terminal
 */
class MicroPythonPseudoTerminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<number>();
    
    onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    onDidClose: vscode.Event<number> = this.closeEmitter.event;

    constructor(
        private device: ESP32Device,
        private deviceManager: DeviceManager
    ) {}

    open(initialDimensions: vscode.TerminalDimensions | undefined): void {
        // Inicializar terminal
        this.writeEmitter.fire('\x1b[31mMicroPython REPL\x1b[0m\r\n');
        this.writeEmitter.fire(`Conectado a ${this.device.name} (${this.device.port})\r\n`);
        this.writeEmitter.fire('Digite comandos Python diretamente:\r\n\r\n');
        
        // Enviar Enter para ativar prompt do MicroPython
        this.deviceManager.executeCommand(this.device.id, '\r\n');
    }

    close(): void {
        this.closeEmitter.fire(0);
    }

    handleInput(data: string): void {
        // Repassar entrada do usuário para o dispositivo
        this.deviceManager.executeCommand(this.device.id, data)
            .catch((error: Error) => {
                this.writeEmitter.fire(`\r\n\x1b[31mErro: ${error.message}\x1b[0m\r\n`);
            });
    }

    setDimensions(dimensions: vscode.TerminalDimensions): void {
        // Terminal dimensions changed, pode ser usado para ajustar layout
    }
}
