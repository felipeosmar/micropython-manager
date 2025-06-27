import * as vscode from 'vscode';
import { DeviceManager } from './deviceManager';
import { DeviceTreeProvider } from './deviceTreeProvider';
import { REPLManager } from './replManager';

/**
 * MicroPython Manager - Extensão VSCode para gerenciar múltiplas conexões ESP32
 * 
 * Problema: Desenvolvedores precisam de ferramenta integrada para trabalhar com múltiplos ESP32
 * Solução: Extensão que oferece descoberta automática, conexões múltiplas e REPL integrado
 * Exemplo: Permite conectar 5 ESP32 simultaneamente e alternar entre eles facilmente
 */

let deviceManager: DeviceManager;
let treeProvider: DeviceTreeProvider;
let replManager: REPLManager;

export function activate(context: vscode.ExtensionContext) {
    console.log('MicroPython Manager ativado!');

    // Inicializar gerenciadores
    deviceManager = new DeviceManager(context);
    treeProvider = new DeviceTreeProvider(deviceManager);
    replManager = new REPLManager(deviceManager);

    // Registrar Tree Data Provider
    vscode.window.createTreeView('micropython-devices', {
        treeDataProvider: treeProvider,
        showCollapseAll: true
    });

    // Registrar comandos
    registerCommands(context);

    // Configurar contexto para mostrar/ocultar views
    vscode.commands.executeCommand('setContext', 'micropython-manager.hasDevices', true);

    vscode.window.showInformationMessage('MicroPython Manager está ativo!');
}

/**
 * Registra todos os comandos da extensão
 */
function registerCommands(context: vscode.ExtensionContext) {
    
    // Comando: Escanear portas seriais
    const scanPortsCommand = vscode.commands.registerCommand('micropython-manager.scanPorts', async () => {
        try {
            vscode.window.showInformationMessage('Escaneando portas seriais...');
            
            const ports = await deviceManager.listSerialPorts();
            
            if (ports.length === 0) {
                vscode.window.showWarningMessage(
                    'Nenhuma porta serial compatível encontrada. Verifique se o ESP32 está conectado.'
                );
                return;
            }

            // Mostrar portas encontradas
            const portItems = ports.map(port => ({
                label: port.path,
                description: `${port.manufacturer || 'Desconhecido'} (${port.vendorId || 'N/A'})`,
                detail: `Serial: ${port.serialNumber || 'N/A'}`,
                port: port
            }));

            const selectedItem = await vscode.window.showQuickPick(portItems, {
                placeHolder: 'Selecione uma porta para conectar',
                title: `${ports.length} porta(s) encontrada(s)`
            });

            if (selectedItem) {
                await deviceManager.connectDevice(selectedItem.port.path);
                treeProvider.refresh();
            }

        } catch (error) {
            vscode.window.showErrorMessage(`Erro ao escanear portas: ${error}`);
        }
    });

    // Comando: Conectar dispositivo manualmente
    const connectDeviceCommand = vscode.commands.registerCommand('micropython-manager.connectDevice', async () => {
        const ports = await deviceManager.listSerialPorts();
        if (ports.length === 0) {
            vscode.window.showWarningMessage('Nenhuma porta serial encontrada. Verifique se o dispositivo está conectado.');
            return;
        }

        const selectedPort = await vscode.window.showQuickPick(
            ports.map(p => ({ label: p.path, description: p.manufacturer })),
            { placeHolder: 'Selecione a porta serial do seu dispositivo' }
        );

        if (selectedPort) {
            await deviceManager.connectDevice(selectedPort.label);
        }
    });

    // Comando: Desconectar dispositivo
    const disconnectDeviceCommand = vscode.commands.registerCommand('micropython-manager.disconnectDevice', async (item) => {
        if (item && item.device) {
            await deviceManager.disconnectDevice(item.device.id);
            treeProvider.refresh();
        }
    });

    // Comando: Desconectar todos os dispositivos
    const disconnectAllCommand = vscode.commands.registerCommand('micropython-manager.disconnectAll', async () => {
        const result = await vscode.window.showWarningMessage(
            'Desconectar todos os dispositivos?',
            { modal: true },
            'Sim', 'Não'
        );

        if (result === 'Sim') {
            await deviceManager.disconnectAll();
            treeProvider.refresh();
        }
    });

    // Comando: Abrir REPL
    const openREPLCommand = vscode.commands.registerCommand('micropython-manager.openREPL', async (item) => {
        if (item && item.device) {
            await replManager.openREPL(item.device.id);
        } else {
            // Se não foi chamado do menu de contexto, mostrar lista de dispositivos
            const devices = deviceManager.getConnectedDevices();
            if (devices.length === 0) {
                vscode.window.showWarningMessage('Nenhum dispositivo conectado');
                return;
            }

            if (devices.length === 1) {
                await replManager.openREPL(devices[0].id);
            } else {
                const deviceItems = devices.map(device => ({
                    label: device.name,
                    description: device.port,
                    device: device
                }));

                const selectedItem = await vscode.window.showQuickPick(deviceItems, {
                    placeHolder: 'Selecione um dispositivo para abrir REPL'
                });

                if (selectedItem) {
                    await replManager.openREPL(selectedItem.device.id);
                }
            }
        }
    });

    // Comando: Executar script
    const runScriptCommand = vscode.commands.registerCommand('micropython-manager.runScript', async () => {
        const devices = deviceManager.getConnectedDevices();
        if (devices.length === 0) {
            vscode.window.showWarningMessage('Nenhum dispositivo conectado');
            return;
        }

        // Selecionar dispositivo
        let targetDevice: any;
        if (devices.length === 1) {
            targetDevice = devices[0];
        } else {
            const deviceItems = devices.map(device => ({
                label: device.name,
                description: device.port,
                device: device
            }));

            const selectedItem = await vscode.window.showQuickPick(deviceItems, {
                placeHolder: 'Selecione um dispositivo para executar o script'
            });

            if (!selectedItem) {
                return;
            }
            targetDevice = selectedItem.device;
        }

        // Verificar se há arquivo aberto no editor
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.languageId === 'python') {
            const result = await vscode.window.showInformationMessage(
                `Executar o arquivo atual (${activeEditor.document.fileName}) no ${targetDevice.name}?`,
                'Sim', 'Selecionar outro arquivo'
            );

            if (result === 'Sim') {
                await replManager.runScript(targetDevice.id, activeEditor.document.fileName);
                return;
            }
        }

        // Selecionar arquivo
        await replManager.runScript(targetDevice.id);
    });

    // Comando: Upload de arquivo
    const uploadFileCommand = vscode.commands.registerCommand('micropython-manager.uploadFile', async (item) => {
        let targetDevice: any;
        
        if (item && item.device) {
            targetDevice = item.device;
        } else {
            const devices = deviceManager.getConnectedDevices();
            if (devices.length === 0) {
                vscode.window.showWarningMessage('Nenhum dispositivo conectado');
                return;
            }

            if (devices.length === 1) {
                targetDevice = devices[0];
            } else {
                const deviceItems = devices.map(device => ({
                    label: device.name,
                    description: device.port,
                    device: device
                }));

                const selectedItem = await vscode.window.showQuickPick(deviceItems, {
                    placeHolder: 'Selecione um dispositivo para upload'
                });

                if (!selectedItem) {
                    return;
                }
                targetDevice = selectedItem.device;
            }
        }

        try {
            const fileUri = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'Python Files': ['py'],
                    'All Files': ['*']
                },
                title: 'Selecionar arquivo para upload'
            });

            if (fileUri && fileUri.length > 0) {
                await deviceManager.uploadFile(targetDevice.id, fileUri[0].fsPath);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Erro no upload: ${error}`);
        }
    });

    // Comando: Reset do dispositivo
    const resetDeviceCommand = vscode.commands.registerCommand('micropython-manager.resetDevice', async (item) => {
        let targetDevice: any;
        
        if (item && item.device) {
            targetDevice = item.device;
        } else {
            const devices = deviceManager.getConnectedDevices();
            if (devices.length === 0) {
                vscode.window.showWarningMessage('Nenhum dispositivo conectado');
                return;
            }

            if (devices.length === 1) {
                targetDevice = devices[0];
            } else {
                const deviceItems = devices.map(device => ({
                    label: device.name,
                    description: device.port,
                    device: device
                }));

                const selectedItem = await vscode.window.showQuickPick(deviceItems, {
                    placeHolder: 'Selecione um dispositivo para reset'
                });

                if (!selectedItem) {
                    return;
                }
                targetDevice = selectedItem.device;
            }
        }

        try {
            const result = await vscode.window.showWarningMessage(
                `Fazer reset do ${targetDevice.name}?`,
                { modal: true },
                'Sim', 'Não'
            );

            if (result === 'Sim') {
                await deviceManager.resetDevice(targetDevice.id);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Erro no reset: ${error}`);
        }
    });

    // Comando: Mostrar informações de memória
    const showMemoryInfoCommand = vscode.commands.registerCommand('micropython-manager.showMemoryInfo', async (item) => {
        let targetDevice: any;
        
        if (item && item.device) {
            targetDevice = item.device;
        } else {
            const devices = deviceManager.getConnectedDevices();
            if (devices.length === 0) {
                vscode.window.showWarningMessage('Nenhum dispositivo conectado');
                return;
            }

            if (devices.length === 1) {
                targetDevice = devices[0];
            } else {
                const deviceItems = devices.map(device => ({
                    label: device.name,
                    description: device.port,
                    device: device
                }));

                const selectedItem = await vscode.window.showQuickPick(deviceItems, {
                    placeHolder: 'Selecione um dispositivo para ver informações de memória'
                });

                if (!selectedItem) {
                    return;
                }
                targetDevice = selectedItem.device;
            }
        }

        try {
            await deviceManager.getMemoryInfo(targetDevice.id);
        } catch (error) {
            vscode.window.showErrorMessage(`Erro ao obter informações: ${error}`);
        }
    });

    // Comando: Listar arquivos
    const listFilesCommand = vscode.commands.registerCommand('micropython-manager.listFiles', async (item) => {
        let targetDevice: any;
        
        if (item && item.device) {
            targetDevice = item.device;
        } else {
            const devices = deviceManager.getConnectedDevices();
            if (devices.length === 0) {
                vscode.window.showWarningMessage('Nenhum dispositivo conectado');
                return;
            }

            if (devices.length === 1) {
                targetDevice = devices[0];
            } else {
                const deviceItems = devices.map(device => ({
                    label: device.name,
                    description: device.port,
                    device: device
                }));

                const selectedItem = await vscode.window.showQuickPick(deviceItems, {
                    placeHolder: 'Selecione um dispositivo para listar arquivos'
                });

                if (!selectedItem) {
                    return;
                }
                targetDevice = selectedItem.device;
            }
        }

        try {
            await deviceManager.listFiles(targetDevice.id);
        } catch (error) {
            vscode.window.showErrorMessage(`Erro ao listar arquivos: ${error}`);
        }
    });

    // Comando: Atualizar arquivos na árvore
    const refreshFilesCommand = vscode.commands.registerCommand('micropython-manager.refreshFiles', async () => {
        treeProvider.clearFileCache();
        vscode.window.showInformationMessage('Lista de arquivos atualizada');
    });

    // Comando: Baixar arquivo do dispositivo
    const downloadFileCommand = vscode.commands.registerCommand('micropython-manager.downloadFile', async (item) => {
        if (!item || !item.file) {
            vscode.window.showWarningMessage('Selecione um arquivo para baixar');
            return;
        }

        if (item.file.isDirectory) {
            vscode.window.showWarningMessage('Não é possível baixar um diretório');
            return;
        }

        try {
            // Selecionar local para salvar
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(item.file.name),
                filters: {
                    'Python Files': ['py'],
                    'All Files': ['*']
                },
                title: `Salvar ${item.file.name}`
            });

            if (saveUri) {
                await deviceManager.downloadFile(item.file.deviceId, item.file.path, saveUri.fsPath);
                vscode.window.showInformationMessage(`Arquivo ${item.file.name} baixado com sucesso`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Erro ao baixar arquivo: ${error}`);
        }
    });

    // Comando: Excluir arquivo do dispositivo
    const deleteFileCommand = vscode.commands.registerCommand('micropython-manager.deleteFile', async (item) => {
        if (!item || !item.file) {
            vscode.window.showWarningMessage('Selecione um arquivo para excluir');
            return;
        }

        const fileType = item.file.isDirectory ? 'diretório' : 'arquivo';
        const result = await vscode.window.showWarningMessage(
            `Excluir ${fileType} "${item.file.name}" do dispositivo?`,
            { modal: true },
            'Sim', 'Não'
        );

        if (result === 'Sim') {
            try {
                await deviceManager.deleteFile(item.file.deviceId, item.file.path, item.file.isDirectory);
                treeProvider.clearFileCache(item.file.deviceId);
                vscode.window.showInformationMessage(`${fileType} excluído com sucesso`);
            } catch (error) {
                vscode.window.showErrorMessage(`Erro ao excluir ${fileType}: ${error}`);
            }
        }
    });

    // Adicionar comandos ao contexto
    context.subscriptions.push(
        scanPortsCommand,
        connectDeviceCommand,
        disconnectDeviceCommand,
        disconnectAllCommand,
        openREPLCommand,
        runScriptCommand,
        uploadFileCommand,
        resetDeviceCommand,
        showMemoryInfoCommand,
        listFilesCommand,
        refreshFilesCommand,
        downloadFileCommand,
        deleteFileCommand
    );
}

export function deactivate() {
    if (deviceManager) {
        deviceManager.dispose();
    }
    if (replManager) {
        replManager.closeAllREPLs();
    }
}
