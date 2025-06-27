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
     * Solução: Terminal que redireciona entrada/saída para porta serial com validação robusta
     * Exemplo: Valida se é MicroPython antes de abrir terminal e mostra ">>>" corretamente
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

        // Mostrar progresso durante validação
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Validando conexão MicroPython com ${device.name}...`,
            cancellable: true
        }, async (progress, token) => {
            try {
                // Validação completa do ambiente MicroPython
                progress.report({ increment: 20, message: 'Executando validação completa...' });
                const validation = await this.validateMicroPythonEnvironment(deviceId);
                
                if (token.isCancellationRequested) {
                    return;
                }

                if (!validation.isValid) {
                    const errorMessage = `Problemas detectados no MicroPython em ${device.name}:\n${validation.issues.join('\n')}`;
                    vscode.window.showErrorMessage(errorMessage, 'Detalhes').then(selection => {
                        if (selection === 'Detalhes') {
                            const outputChannel = this.deviceManager.getOutputChannel(deviceId);
                            if (outputChannel) {
                                outputChannel.show();
                                outputChannel.appendLine('\n=== Problemas de Validação MicroPython ===');
                                validation.issues.forEach(issue => outputChannel.appendLine(`• ${issue}`));
                                outputChannel.appendLine('=== Tente resetar o dispositivo ou verificar a conexão ===\n');
                            }
                        }
                    });
                    return;
                }

                progress.report({ increment: 60, message: 'Testando comandos básicos...' });
                
                // Validação adicional de responsividade
                const isResponsive = await this.testBasicCommands(deviceId);
                
                if (token.isCancellationRequested) {
                    return;
                }

                if (!isResponsive) {
                    vscode.window.showErrorMessage(
                        `MicroPython em ${device.name} não está respondendo consistentemente aos comandos. Tente resetar o dispositivo.`
                    );
                    return;
                }

                progress.report({ increment: 80, message: 'Preparando terminal...' });

                // Preparar dispositivo para REPL interativo
                await this.prepareDeviceForREPL(deviceId);

                if (token.isCancellationRequested) {
                    return;
                }

                progress.report({ increment: 100, message: 'Abrindo REPL...' });

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

                vscode.window.showInformationMessage(`REPL MicroPython validado e aberto para ${device.name}`);

            } catch (error) {
                vscode.window.showErrorMessage(`Erro ao validar/abrir REPL: ${error}`);
            }
        });
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
            // Entrar no modo "raw" para execução de script (Ctrl+A)
            await this.deviceManager.executeCommand(deviceId, '\x01');

            // Enviar o script para execução
            await this.deviceManager.executeCommand(deviceId, scriptContent);

            // Ctrl+D faz um soft reset, que executa o código e retorna ao REPL
            await this.deviceManager.executeCommand(deviceId, '\x04'); 

            outputChannel.appendLine('=== Script enviado para execução. A saída aparecerá abaixo. ===\n');

        } catch (error) {
            outputChannel.appendLine(`=== Erro na execução: ${error} ===\n`);
            // Garante que saia do modo raw em caso de erro
            await this.deviceManager.executeCommand(deviceId, '\x02');
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

    /**
     * Valida se o dispositivo está executando MicroPython
     * 
     * Problema: Necessário verificar se dispositivo responde com prompt MicroPython
     * Solução: Usa estratégia de comando + verificação temporal para validar resposta
     * Exemplo: Envia comandos de teste e verifica se dispositivo está responsivo
     */
    private async validateMicroPythonConnection(deviceId: string): Promise<boolean> {
        try {
            const device = this.deviceManager.getDevice(deviceId);
            if (!device) {
                return false;
            }

            // Salvar timestamp antes dos testes
            const initialActivity = device.lastActivity;
            
            // Teste 1: Interromper execução atual e acordar REPL
            await this.deviceManager.executeCommand(deviceId, '\x03'); // Ctrl+C
            await this.sleep(300);
            
            // Teste 2: Enviar comando simples que deve retornar resposta
            await this.deviceManager.executeCommand(deviceId, '\r\n');
            await this.sleep(200);
            
            // Verificar se houve atividade recente (indicando resposta)
            const currentDevice = this.deviceManager.getDevice(deviceId);
            if (!currentDevice || !currentDevice.lastActivity) {
                return false;
            }

            // Se lastActivity foi atualizada, dispositivo está respondendo
            const hasRecentActivity = !initialActivity || 
                currentDevice.lastActivity.getTime() > initialActivity.getTime();
            
            if (!hasRecentActivity) {
                return false;
            }

            // Teste 3: Comando Python específico para confirmar MicroPython
            await this.deviceManager.executeCommand(deviceId, 'print("MP_VALIDATE")\r\n');
            await this.sleep(400);
            
            // Verificar nova atividade após comando Python
            const finalDevice = this.deviceManager.getDevice(deviceId);
            if (!finalDevice || !finalDevice.lastActivity) {
                return false;
            }

            // Confirmar que houve atividade após o comando Python
            return finalDevice.lastActivity.getTime() > currentDevice.lastActivity.getTime();
            
        } catch (error) {
            console.error('Erro na validação MicroPython:', error);
            return false;
        }
    }

    /**
     * Testa comandos básicos do MicroPython
     * 
     * Problema: Dispositivo pode estar conectado mas não executando Python corretamente
     * Solução: Executa sequência de comandos Python e verifica responsividade
     * Exemplo: Testa import, print e sys para garantir funcionalidade completa
     */
    private async testBasicCommands(deviceId: string): Promise<boolean> {
        try {
            // Teste 1: Print simples
            const printOutput = await this.deviceManager.executeCommand(deviceId, 'print(123)');
            if (!printOutput.includes('123')) return false;

            // Teste 2: Import básico
            const importOutput = await this.deviceManager.executeCommand(deviceId, 'import gc');
            if (importOutput.toLowerCase().includes('error')) return false;

            // Teste 3: Comando com resposta esperada
            const testOkOutput = await this.deviceManager.executeCommand(deviceId, 'print("TEST_OK")');
            if (!testOkOutput.includes('TEST_OK')) return false;

            return true;
            
        } catch (error) {
            console.error('Erro no teste de comandos básicos:', error);
            return false;
        }
    }

    /**
     * Prepara dispositivo para uso interativo no REPL
     * 
     * Problema: Dispositivo pode estar em estado não ideal para REPL
     * Solução: Limpa buffer, interrompe execuções e prepara prompt limpo
     * Exemplo: Garante que prompt ">>>" esteja disponível e responsivo
     */
    private async prepareDeviceForREPL(deviceId: string): Promise<void> {
        try {
            // Interromper qualquer execução em andamento (Ctrl+C)
            await this.deviceManager.executeCommand(deviceId, '\x03');
            
            // Limpar buffer e garantir que estamos no prompt (Enter)
            await this.deviceManager.executeCommand(deviceId, ''); // Envia um enter vazio
            
        } catch (error) {
            console.error('Erro ao preparar dispositivo para REPL:', error);
            throw new Error('Falha ao preparar dispositivo para REPL');
        }
    }

    /**
     * Captura resposta do dispositivo para um comando específico.
     * 
     * Problema: Necessário aguardar e capturar resposta específica do dispositivo.
     * Solução: Usa a promise retornada pelo novo `executeCommand`, que já captura a saída até o próximo prompt.
     * Exemplo: `const output = await captureDeviceResponse(id, 'print(1+1)')` captura "2".
     */
    private async captureDeviceResponse(deviceId: string, command: string): Promise<string> {
        // Com a nova implementação do DeviceManager, basta chamar o executeCommand.
        // O timeout já é gerenciado dentro do processador da fila de comandos.
        return this.deviceManager.executeCommand(deviceId, command);
    }

    /**
     * Executa validação completa do ambiente MicroPython
     * 
     * Problema: Dispositivo pode estar conectado mas com problemas específicos do MicroPython
     * Solução: Bateria completa de testes para garantir funcionalidade plena
     * Exemplo: Testa REPL, imports, memória e comandos específicos do ESP32
     */
    private async validateMicroPythonEnvironment(deviceId: string): Promise<{isValid: boolean, issues: string[]}> {
        const issues: string[] = [];
        
        try {
            // Validação 1: Responsividade básica (envia um enter e espera o prompt)
            const enterOutput = await this.captureDeviceResponse(deviceId, '');
            if (!enterOutput.includes('>>>')) {
                issues.push('Dispositivo não responde com o prompt ">>>" do REPL.');
                return { isValid: false, issues };
            }

            // Validação 2: Capacidade Python básica
            const mathOutput = await this.captureDeviceResponse(deviceId, 'print(1+1)');
            if (!mathOutput.includes('2')) {
                issues.push('Interpretador Python não processa comandos matemáticos.');
            }

            // Validação 3: Capacidade de import
            const importOutput = await this.captureDeviceResponse(deviceId, 'import sys');
            if (importOutput.toLowerCase().includes('error')) {
                issues.push('Sistema de imports do Python não está funcionando.');
            }

            // Validação 4: Específica do MicroPython
            const mpOutput = await this.captureDeviceResponse(deviceId, 'import micropython');
            if (mpOutput.toLowerCase().includes('error')) {
                issues.push('Módulo "micropython" não disponível.');
            }

            // Validação 5: Comandos específicos do ESP32
            const machineOutput = await this.captureDeviceResponse(deviceId, 'import machine');
            if (machineOutput.toLowerCase().includes('error')) {
                issues.push('Módulo "machine" não disponível.');
            }

            const isValid = issues.length < 2; // Permite no máximo 1 falha
            if (!isValid) {
                issues.unshift(`Muitas validações falharam (${issues.length}).`);
            }

            return {isValid, issues};

        } catch (error) {
            issues.push(`Erro fatal durante validação: ${error}`);
            return {isValid: false, issues};
        }
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
    private dataListener: ((data: string) => void) | null = null;
    private inputBuffer: string = '';
    private isInitialized: boolean = false;
    
    onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    onDidClose: vscode.Event<number> = this.closeEmitter.event;

    constructor(
        private device: ESP32Device,
        private deviceManager: DeviceManager
    ) {}

    open(initialDimensions: vscode.TerminalDimensions | undefined): void {
        // Inicializar terminal
        this.writeEmitter.fire('\x1b[32m=== MicroPython REPL ===\x1b[0m\r\n');
        this.writeEmitter.fire(`Conectado a ${this.device.name} (${this.device.port})\r\n`);
        this.writeEmitter.fire('Dispositivo validado com sucesso!\r\n');
        this.writeEmitter.fire('\x1b[36mDigite comandos Python diretamente:\x1b[0m\r\n\r\n');
        
        // Configurar listener para dados do dispositivo
        this.setupDataListener();
        
        // Inicializar REPL
        this.initializeREPL();
    }

    close(): void {
        // Remover listener quando terminal fechar
        if (this.dataListener) {
            const parser = this.deviceManager.getParser(this.device.id);
            if (parser) {
                parser.off('data', this.dataListener);
            }
            this.dataListener = null;
        }
        this.closeEmitter.fire(0);
    }

    handleInput(data: string): void {
        // Simplesmente envia os dados do terminal para a fila de comandos do dispositivo.
        // A fila garante que tudo será processado em ordem.
        this.sendCommand(data);
    }

    setDimensions(dimensions: vscode.TerminalDimensions): void {
        // Terminal dimensions changed, pode ser usado para ajustar layout
    }

    /**
     * Configura listener para capturar dados do dispositivo
     */
    private setupDataListener(): void {
        const parser = this.deviceManager.getParser(this.device.id);
        if (!parser) {
            this.writeEmitter.fire('\x1b[31mErro: Parser não encontrado\x1b[0m\r\n');
            return;
        }

        this.dataListener = (data: string) => {
            // Repassa os dados brutos do dispositivo para o terminal do VS Code,
            // substituindo newlines para a formatação correta do terminal.
            this.writeEmitter.fire(data.replace(/\n/g, '\r\n'));
        };

        parser.on('data', this.dataListener);
    }

    /**
     * Verifica se os dados recebidos são eco do input do usuário
     */
    private isEchoOfInput(data: string): boolean {
        // Esta função se torna desnecessária, pois o REPL lida com o eco.
        // A melhor abordagem é desativar o eco no dispositivo se isso se tornar um problema.
        return false;
    }

    /**
     * Inicializa o REPL enviando comandos de configuração
     */
    private async initializeREPL(): Promise<void> {
        try {
            this.writeEmitter.fire('Inicializando REPL...\r\n');
            
            // 1. Interromper qualquer execução para garantir um estado limpo
            await this.sendCommand('\x03'); // Ctrl+C
            
            // 2. Enviar um enter para obter um prompt limpo
            await this.sendCommand('\r\n');
            
            this.isInitialized = true;
            this.writeEmitter.fire('\x1b[32m✓ REPL pronto!\x1b[0m\r\n');
            
        } catch (error) {
            this.writeEmitter.fire(`\x1b[31mErro ao inicializar REPL: ${error}\x1b[0m\r\n`);
        }
    }

    /**
     * Envia comando para o dispositivo
     */
    private async sendCommand(command: string): Promise<void> {
        try {
            // Não precisamos do retorno aqui, pois o listener de dados já exibe a saída.
            // Apenas enviamos o comando para a fila.
            this.deviceManager.executeCommand(this.device.id, command);
        } catch (error) {
            this.writeEmitter.fire(`\r\n\x1b[31mErro de comunicação: ${error}\x1b[0m\r\n`);
        }
    }

    /**
     * Utilitário para pausas
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
