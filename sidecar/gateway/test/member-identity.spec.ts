import { MemberIdentityService } from '../src/identity/member-identity.service';

describe('MemberIdentityService (四层成员身份判定引擎)', () => {
  let service: MemberIdentityService;

  beforeEach(() => {
    service = new MemberIdentityService();
    // 注入默认客服与合作方白名单配置
    service.setCsStaff(['cs_user_001', 'cs_supervisor_888']);
    service.setPartnerCorpWhitelist(['4S店', '太平洋保险', '人保财险']);
  });

  describe('1. 核心用例 S21 门禁：销售等内部非客服员工发言', () => {
    it('【S21 验证】群内销售（本企业成员 type=1，不在客服名单中）发言，识别为 STAFF_OTHER', () => {
      const result = service.identify({
        tenantId: 1,
        memberId: 'sales_rep_lisi',
        botUserId: 'bot_agent_ai',
        rawInfo: {
          userid: 'sales_rep_lisi',
          name: '李四（销售顾问）',
          type: 1, // 1 = 本企业成员
        },
      });

      expect(result).toEqual({
        memberId: 'sales_rep_lisi',
        role: 'STAFF_OTHER',
        source: 'INTERNAL_OTHER',
        name: '李四（销售顾问）',
        rawType: 1,
      });
    });

    it('本企业成员（type=1）且在客服名单中，准确识别为 STAFF_CS', () => {
      const result = service.identify({
        tenantId: 1,
        memberId: 'cs_user_001',
        botUserId: 'bot_agent_ai',
        rawInfo: {
          userid: 'cs_user_001',
          name: '张三（专属客服）',
          type: 1,
        },
      });

      expect(result).toEqual({
        memberId: 'cs_user_001',
        role: 'STAFF_CS',
        source: 'INTERNAL_CS',
        name: '张三（专属客服）',
        rawType: 1,
      });
    });

    it('支持单次调用传入 customCsStaffList 覆盖/扩展客服判定', () => {
      const result = service.identify({
        tenantId: 1,
        memberId: 'temp_duty_cs_99',
        botUserId: 'bot_agent_ai',
        rawInfo: {
          userid: 'temp_duty_cs_99',
          name: '王五（值班客服）',
          type: 1,
        },
        customCsStaffList: ['temp_duty_cs_99'],
      });

      expect(result.role).toBe('STAFF_CS');
      expect(result.source).toBe('INTERNAL_CS');
    });
  });

  describe('2. 第一层：BOT 自身识别', () => {
    it('当发送人 memberId 等于 botUserId 时，无论是否有其他属性均识别为 BOT 并直接忽略', () => {
      const result = service.identify({
        tenantId: 1,
        memberId: 'bot_agent_ai',
        botUserId: 'bot_agent_ai',
        rawInfo: {
          userid: 'bot_agent_ai',
          name: 'AI 智能体小助手',
          type: 1,
        },
      });

      expect(result).toEqual({
        memberId: 'bot_agent_ai',
        role: 'BOT',
        source: 'BOT',
        name: 'AI 智能体小助手',
        rawType: 1,
      });
    });
  });

  describe('3. 第三层：外部联系人细分（客户 vs 合作方）', () => {
    it('外部联系人（type=2）且 externalType=1（微信个人用户），识别为 CUSTOMER', () => {
      const result = service.identify({
        tenantId: 1,
        memberId: 'wm_wx_user_888',
        botUserId: 'bot_agent_ai',
        rawInfo: {
          userid: 'wm_wx_user_888',
          name: '车主王先生',
          type: 2,
          externalType: 1, // 微信用户
        },
      });

      expect(result).toEqual({
        memberId: 'wm_wx_user_888',
        role: 'CUSTOMER',
        source: 'EXTERNAL_WECHAT',
        name: '车主王先生',
        rawType: 2,
      });
    });

    it('外部联系人（type=2）且 externalType=2（企业微信用户）且所属企业在白名单中，识别为 PARTNER', () => {
      const result = service.identify({
        tenantId: 1,
        memberId: 'wo_corp_user_4s',
        botUserId: 'bot_agent_ai',
        rawInfo: {
          userid: 'wo_corp_user_4s',
          name: '赵六（服务顾问）',
          type: 2,
          externalType: 2,
          corpName: '问界授权某某4S店维修中心',
        },
      });

      expect(result).toEqual({
        memberId: 'wo_corp_user_4s',
        role: 'PARTNER',
        source: 'EXTERNAL_PARTNER',
        name: '赵六（服务顾问）',
        corpName: '问界授权某某4S店维修中心',
        rawType: 2,
      });
    });

    it('外部联系人（type=2）且 externalType=2 但所属企业不在白名单中，仍安全识别为 CUSTOMER', () => {
      const result = service.identify({
        tenantId: 1,
        memberId: 'wo_corp_client_other',
        botUserId: 'bot_agent_ai',
        rawInfo: {
          userid: 'wo_corp_client_other',
          name: '孙先生',
          type: 2,
          externalType: 2,
          corpName: '北京某某文化传媒有限公司',
        },
      });

      expect(result).toEqual({
        memberId: 'wo_corp_client_other',
        role: 'CUSTOMER',
        source: 'EXTERNAL_CUSTOMER',
        name: '孙先生',
        corpName: '北京某某文化传媒有限公司',
        rawType: 2,
      });
    });
  });

  describe('4. 第 ⓪ 优先级：人工干预与改角色', () => {
    it('运营人工改角色（manualRole）优先级最高，超越所有规则判定', () => {
      const result = service.identify({
        tenantId: 1,
        memberId: 'sales_rep_lisi',
        botUserId: 'bot_agent_ai',
        manualRole: 'STAFF_CS', // 人工把销售标为客服
        rawInfo: {
          userid: 'sales_rep_lisi',
          name: '李四',
          type: 1,
        },
      });

      expect(result).toEqual({
        memberId: 'sales_rep_lisi',
        role: 'STAFF_CS',
        source: 'MANUAL',
        name: '李四',
        rawType: 1,
      });
    });
  });

  describe('5. 兜底回退规则（信息缺失或同步异常）', () => {
    it('缺少 rawInfo 但 memberId 格式符合 wm-/wo- 企微外部联系人规范，按 CUSTOMER 粗判', () => {
      const result = service.identify({
        tenantId: 1,
        memberId: 'wm_unknown_new_customer',
        botUserId: 'bot_agent_ai',
      });

      expect(result).toEqual({
        memberId: 'wm_unknown_new_customer',
        role: 'CUSTOMER',
        source: 'FALLBACK',
      });
    });

    it('缺少 rawInfo 且无法通过 ID 前缀判断，一律安全回退降级为 CUSTOMER，绝不误判为我方员工', () => {
      const result = service.identify({
        tenantId: 1,
        memberId: 'random_unrecognized_id_999',
        botUserId: 'bot_agent_ai',
      });

      expect(result).toEqual({
        memberId: 'random_unrecognized_id_999',
        role: 'CUSTOMER',
        source: 'FALLBACK',
      });
    });
  });
});
