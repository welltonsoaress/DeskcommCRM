# Assistente de gestão pelo WhatsApp — fases 3 a 5

Escopo confirmado pelo usuário: usar a proposta posterior de homologação, comandos controlados e relatórios/automação; incluir tarefas e atendimento. Os indicadores clínicos foram escolhidos a partir dos dados realmente disponíveis no CRM. Esta especificação descreve a implementação desta branch e as provas que ainda faltam.

## Fase 3 — homologação

O [roteiro de homologação](../runbooks/assistente-gestao-whatsapp.md) cobre cadastro, confirmação do número, pergunta real, cron, entrega, reconexão, permissão revogada e isolamento entre organizações. O E2E local exercita cadastro e o ciclo de mensagem persistida → cron → outbox com comercial desligado. **Pendente:** executar o roteiro numa VPS de homologação com banco migrado, scheduler e WAHA pareado. Sem essa prova, não declarar o canal real homologado.

## Fase 4 — comandos com confirmação

**CONFIRMADO pelo código:** cada organização ativa comandos separadamente na tela; o padrão é desligado. Apenas o usuário gestor verificado, ainda ativo como manager/admin, pode preparar e confirmar. O modelo pode consultar dados do próprio tenant e criar **uma proposta**, sem acesso direto às ferramentas de escrita. Ela fica em `management_actions` com prazo de dez minutos e código de seis dígitos guardado como HMAC. A mensagem pendente na outbox fica cifrada até o envio, e o modelo não recebe o código. A resposta `CONFIRMAR <código>` é reduzida a HMAC no ingresso, antes de gravar a mensagem.

Após confirmar, o worker verifica vínculo, papel, organização, prazo e estado da entidade. O banco impede reutilizar um código pelo mesmo gestor na mesma sessão. O claim de estado impede duas execuções da mesma proposta. Se o resultado ficar incerto, não repete automaticamente: mostra o estado no histórico e abre pendência na Central para conferência do CRM. Repetir a mesma confirmação de uma ação concluída devolve o resultado persistido, mesmo que exista outra proposta pendente. Cinco códigos errados cancelam a proposta.

**Revisão de confiabilidade:** a confirmação procura primeiro a proposta do código recebido, inclusive quando outra proposta está pendente ou vencida. Mudança de etapa/atendimento e prazo de tarefa vencido recusam a execução com motivo persistido; falhas em que não se pode provar o resultado continuam incertas. Na entrega, o código precisa corresponder à proposta vigente do mesmo gestor e sessão. A mensagem informa o prazo restante; se a proposta vencer na fila, o gestor recebe orientação para enviar um pedido novo, sem código inutilizável. Perguntas anteriores à verificação do vínculo atual e respostas geradas durante uma troca de gestor são descartadas. Transferência e retomada registram o usuário gestor na auditoria sem inventar um token de API.

| Comando | Efeito confirmado |
|---|---|
| Mover negócio | Usa a operação canônica `crm_move_lead_stage`, no mesmo funil, após conferir a etapa original. |
| Criar tarefa | Cria tarefa para o gestor com título e prazo futuro; pode vinculá-la a um negócio da empresa. |
| Reservar agendamento | Exige cliente identificado, tipo da agenda e horário já combinado com o cliente. O responsável é fixado na proposta, inclusive quando veio do padrão do tipo. Usa `crm_book_appointment`, que revalida disponibilidade na confirmação; só responde sucesso após ler o compromisso persistido com o mesmo cliente, tipo, responsável e horário. O tipo pode exigir confirmação posterior do cliente. |
| Solicitar agendamento | Cria tarefa para a equipe confirmar cliente e horário desejado. **Não** reserva a agenda nem avisa o cliente. |
| Transferir atendimento | Usa a atribuição canônica de conversa para atendente ativo ou a devolve à fila. |
| Pausar a IA do atendimento | Aciona a passagem canônica da conversa para atendimento humano. |
| Retomar a IA | Usa a operação canônica de retorno da conversa para a IA, com ator humano. |

Enviar mensagem ao cliente, cancelar compromisso e encerrar caso não fazem parte deste conjunto. Nenhuma proposta concede poder a um usuário que perdeu o papel ou a uma sessão de outra organização.

## Fase 5 — relatórios e avisos

**CONFIRMADO pelo código:** `resumo da semana`, `relatório semanal` e `comparativo semanal` têm resposta determinística com dois períodos consecutivos de sete **dias locais completos**, no fuso da organização. Contam oportunidades criadas e agendamentos que **estão atualmente confirmados**, com diferença absoluta entre períodos. Também é possível ativar envio semanal e escolher dia e hora na tela. Por padrão o envio está desligado. A chave `weekly:<dia local>` evita repetição.

O aviso opcional de **tarefa vencida e aberta** usa o prazo e o estado de `crm_tasks`, respeita o limite diário de avisos e revalida a tarefa antes do envio. A seleção de categorias existentes (Central, Radar, tarefas) e o teto diário permitem que cada empresa escolha o que quer receber. Não há dados de faltas, atendimentos realizados ou faturamento medidos por esta função; esses números não aparecem como se fossem fatos clínicos.

## Limites de validação

Typecheck, lint e testes focados verificam a lógica local. A migration 0238 precisa passar pelo gate de banco com Docker, incluindo instalação e atualização pelo `baseline.sql`; o E2E precisa rodar contra Supabase local; o roteiro da fase 3 precisa de uma instalação de homologação e números de teste. Esses passos são condições para liberar o recurso em produção.
